import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AlertCircle, ArrowLeft, CheckCircle2, Clock, FileText, Inbox, Loader2, RefreshCw } from 'lucide-react';
import { getUsers } from '../../store';
import { completeDbWorkItem, dbWorkItemToAction, fetchWorkItems } from '../../lib/workflowApi';

const AVATAR_COLORS = [
  'bg-violet-200 text-violet-700',
  'bg-sky-200 text-sky-700',
  'bg-emerald-200 text-emerald-700',
  'bg-amber-200 text-amber-700',
];

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

function buildInitialPatch(item) {
  const refs = item.dbPayload?.references || {};
  return {
    patient: {},
    order: {},
    references: {},
    practitioner: { ...(refs.practitioner || {}) },
    PG: { ...(refs.PG || {}) },
    HHAH: { ...(refs.HHAH || {}) },
  };
}

function referenceFieldsForTask(taskKind) {
  if (taskKind === 'human.createPractitioner') {
    return [
      { label: 'NPI', key: 'NPI', root: 'practitioner' },
      { label: 'Physician name', key: 'physician_name', root: 'practitioner' },
      { label: 'Speciality', key: 'speciality', root: 'practitioner' },
    ];
  }
  if (taskKind === 'human.createPg') {
    return [
      { label: 'PG name', key: 'name', root: 'PG' },
      { label: 'NPI', key: 'NPI', root: 'PG' },
      { label: 'Type', key: 'type', root: 'PG' },
    ];
  }
  return [];
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

// Lisa: show object lifecycle (found/missing/created/updated/in-review) per the
// diagram's objects, derived from the item's decision flags. Mirrors
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

function RecordSummary({ item, missingFields }) {
  const patient = item.dbPayload?.patient || {};
  const order = item.dbPayload?.order || {};
  const refs = item.dbPayload?.references || {};
  const missing = new Set(missingFields);

  const valueClass = (field) => missing.has(field) ? 'text-rose-700 bg-rose-50 rounded px-1 font-bold' : 'text-slate-700';
  return (
    <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
      <LifecycleStrip decisions={item.dbPayload?.decisions} />
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

function MissingFieldsEditor({ item, patch, setPatch, missingFields }) {
  const fields = missingFields
    .map((field) => ({ field, def: FIELD_DEFS[field] }))
    .filter((entry) => entry.def);
  const referenceFields = referenceFieldsForTask(item.taskKind);

  function updateMissing(def, value) {
    setPatch((current) => ({
      ...current,
      [def.section]: setIn(current[def.section], def.path, value),
    }));
  }

  function updateReference(root, key, value) {
    setPatch((current) => ({
      ...current,
      [root]: { ...(current[root] || {}), [key]: value },
    }));
  }

  if (!fields.length && !referenceFields.length) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-3 text-xs text-slate-500">
        No missing fields were reported for this task. Add notes or confirm the record after reviewing the PDF.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {fields.length > 0 && (
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
      )}

      {referenceFields.length > 0 && (
        <div>
          <div className="text-xs font-bold uppercase tracking-wide text-slate-600 mb-2">Create reference record</div>
          <div className="grid md:grid-cols-2 gap-2">
            {referenceFields.map((field) => (
              <label key={`${field.root}-${field.key}`} className="block rounded-xl border border-slate-200 bg-white p-2">
                <span className="text-[11px] font-bold text-slate-600">{field.label}</span>
                <input
                  value={patch[field.root]?.[field.key] || ''}
                  onChange={(event) => updateReference(field.root, field.key, event.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-violet-300"
                />
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function PdfPanel({ item }) {
  const pdfUrl = item.dbPayload?.pdf?.url;
  return (
    <div className="rounded-xl border border-slate-200 bg-white overflow-hidden min-h-[620px]">
      <div className="px-3 py-2 border-b border-slate-100 flex items-center gap-2">
        <FileText size={15} className="text-slate-400" />
        <span className="text-sm font-semibold text-slate-700">{item.dbPayload?.pdf?.fileName || 'Order PDF'}</span>
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

function ActionCard({ item, onComplete }) {
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState('');
  const [patch, setPatch] = useState(() => buildInitialPatch(item));
  const [loading, setLoading] = useState(false);
  const missingFields = item.dbPayload?.missingFields || [];

  async function handleComplete() {
    setLoading(true);
    try {
      await onComplete(item, notes, payloadForSubmit(patch));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
      <div className="flex items-start gap-3 p-4">
        <div className="w-10 h-10 rounded-xl bg-violet-100 flex items-center justify-center shrink-0 mt-0.5">
          <CheckCircle2 size={16} className="text-violet-500" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-slate-800 leading-tight">{item.taskName}</span>
            <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-amber-100 text-amber-700">in progress</span>
            {missingFields.length > 0 && (
              <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-rose-100 text-rose-700">
                {missingFields.length} missing
              </span>
            )}
          </div>
          {item.description && <div className="text-xs text-slate-500 mt-1 leading-snug">{item.description}</div>}
          <div className="flex items-center gap-2 mt-1.5 flex-wrap text-xs text-slate-400">
            <span className="font-medium text-slate-500">{item.workflowName}</span>
            <span className="text-slate-300">|</span>
            <span className="flex items-center gap-1">
              <Clock size={10} />
              {new Date(item.launchedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
            </span>
          </div>
        </div>
        <button
          onClick={() => setOpen((value) => !value)}
          className={`shrink-0 px-3 py-1.5 rounded-xl text-sm font-medium transition-colors ${open ? 'bg-violet-600 text-white' : 'bg-violet-50 text-violet-700 hover:bg-violet-100'}`}>
          {open ? 'Cancel' : 'Open'}
        </button>
      </div>

      {open && (
        <div className="border-t border-slate-100 bg-slate-50/50 p-4">
          <div className="grid xl:grid-cols-[minmax(0,1fr)_520px] gap-4">
            <div className="space-y-3">
              <RecordSummary item={item} missingFields={missingFields} />
              <MissingFieldsEditor item={item} patch={patch} setPatch={setPatch} missingFields={missingFields} />
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
              <button
                onClick={handleComplete}
                disabled={loading}
                className="inline-flex items-center gap-2 px-4 py-2.5 bg-green-600 text-white rounded-xl hover:bg-green-700 text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {loading ? <Loader2 size={16} className="animate-spin" /> : <CheckCircle2 size={16} />}
                {loading ? 'Saving...' : 'Save fields & continue'}
              </button>
            </div>
            <PdfPanel item={item} />
          </div>
        </div>
      )}
    </div>
  );
}

function CompletedCard({ item }) {
  return (
    <div className="flex items-center gap-3 bg-white rounded-xl border border-slate-100 px-4 py-3">
      <CheckCircle2 size={16} className="text-green-500 shrink-0" />
      <div className="flex-1 min-w-0">
        <span className="text-sm text-slate-500 line-through">{item.actionName}</span>
        <span className="mx-1.5 text-slate-300">|</span>
        <span className="text-xs text-slate-400">{item.workflowName} / {item.taskName}</span>
      </div>
      {item.completedAt && (
        <span className="text-xs text-slate-400 shrink-0">
          {new Date(item.completedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
      )}
    </div>
  );
}

export default function WorkBucket() {
  const { userId } = useParams();
  const navigate = useNavigate();
  const users = getUsers();
  const user = users.find((candidate) => candidate.id === userId);
  const userIdx = users.findIndex((candidate) => candidate.id === userId);
  const [pending, setPending] = useState([]);
  const [completed, setCompleted] = useState([]);
  const [dbError, setDbError] = useState(null);

  const refresh = useCallback(() => {
    fetchWorkItems(userId)
      .then((data) => {
        setPending((data.pending || []).map(dbWorkItemToAction));
        setCompleted((data.completed || []).map(dbWorkItemToAction));
        setDbError(null);
      })
      .catch((error) => {
        setPending([]);
        setCompleted([]);
        setDbError(error.message);
      });
  }, [userId]);

  useEffect(() => {
    refresh();
    const onFocus = () => refresh();
    const onVisibility = () => { if (!document.hidden) refresh(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [refresh]);

  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <p className="text-slate-500 mb-4">User not found.</p>
          <button onClick={() => navigate('/worker')} className="text-violet-600 hover:underline text-sm">Back</button>
        </div>
      </div>
    );
  }

  async function handleComplete(item, notes, payload) {
    await completeDbWorkItem({ runId: item.instanceId, taskRunId: item.actionInstanceId, notes, payload });
    refresh();
  }

  const avatarCls = AVATAR_COLORS[userIdx % AVATAR_COLORS.length];

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-100 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center gap-3">
          <button onClick={() => navigate('/worker')} className="p-2 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors">
            <ArrowLeft size={18} />
          </button>
          <div className={`w-8 h-8 rounded-lg flex items-center justify-center font-bold text-sm ${avatarCls}`}>
            {user.name[0]}
          </div>
          <div className="flex-1">
            <div className="font-semibold text-slate-800 text-sm">{user.name}</div>
            <div className="text-xs text-slate-400">Work Bucket</div>
          </div>
          <button onClick={refresh} className="p-2 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors">
            <RefreshCw size={16} />
          </button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-6 space-y-6">
        {dbError && (
          <div className="flex items-start gap-2 px-4 py-3 bg-amber-50 border border-amber-200 rounded-xl text-amber-800 text-sm">
            <AlertCircle size={16} className="mt-0.5 shrink-0" />
            <span>DB work bucket unavailable: {dbError}</span>
          </div>
        )}

        <section>
          <div className="flex items-center gap-2 mb-3">
            <span className="w-2 h-2 rounded-full bg-amber-400" />
            <h2 className="text-sm font-semibold text-slate-700">
              Pending
              {pending.length > 0 && <span className="ml-2 px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 text-xs font-bold">{pending.length}</span>}
            </h2>
          </div>

          {pending.length === 0 ? (
            <div className="text-center py-12 text-slate-400">
              <Inbox size={36} className="mx-auto mb-3 opacity-30" />
              <p className="font-medium text-slate-500">No pending tasks.</p>
              <p className="text-xs mt-1">New HHH workflow tasks appear here when assigned.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {pending.map((item) => (
                <ActionCard key={item.actionInstanceId} item={item} onComplete={handleComplete} />
              ))}
            </div>
          )}
        </section>

        {completed.length > 0 && (
          <section>
            <div className="flex items-center gap-2 mb-3">
              <span className="w-2 h-2 rounded-full bg-green-400" />
              <h2 className="text-sm font-semibold text-slate-500">Completed ({completed.length})</h2>
            </div>
            <div className="space-y-2">
              {completed.map((item) => (
                <CompletedCard key={item.actionInstanceId} item={item} />
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
