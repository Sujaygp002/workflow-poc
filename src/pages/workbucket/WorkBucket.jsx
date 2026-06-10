import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { CheckCircle2, Clock, ChevronDown, ChevronUp, ArrowLeft, RefreshCw, Inbox, Eye, EyeOff } from 'lucide-react';
import { getUsers, getMyWorkItems, getMyCompletedItems, completeActionInstance, getModule, setTaskFormData, getInstance, validateRecord } from '../../store';
import RecordView from '../../components/RecordView';

// Plausible valid sample per module (a button prefills it for the demo).
const SAMPLES = {
  PG: {
    name: 'Lakeside Family Practice', npi: '1234567890', type: 'Single-Specialty Group',
    phone_number: '512-555-0143', email: 'contact@lakesidefp.com',
    address: '101 Lavaca St', city: 'Austin', state: 'TX', county: 'Travis', zip: '78701',
  },
  Agency: {
    name: 'Boise Home Health', npi: '9876543210', type: 'Home Health Agency',
    type_of_service: 'Skilled Nursing', phone_number: '208-555-0199', email: 'intake@boisehh.com',
    address: '500 Capitol Blvd', city: 'Boise', state: 'ID', county: 'Ada', zip: '83702',
  },
};

// Schema-driven form for a fill task.
function FillForm({ module, data, onChange }) {
  const mod = getModule(module);
  if (!mod) return null;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="text-xs font-semibold text-slate-600 uppercase tracking-wide">{mod.label} details</label>
        <button type="button" onClick={() => onChange({ ...(SAMPLES[module] || {}) })}
          className="text-[11px] px-2 py-0.5 rounded-full border border-violet-200 text-violet-600 hover:bg-violet-50">
          fill sample
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {mod.fields.map(f => (
          <div key={f.key} className={f.key === 'address' || f.key === 'name' ? 'col-span-2' : ''}>
            <label className="block text-[11px] text-slate-500 mb-0.5">
              {f.label}{f.required && <span className="text-rose-400"> *</span>}
            </label>
            <input
              className="w-full border border-slate-200 rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-400 bg-white"
              value={data[f.key] || ''}
              onChange={e => onChange({ ...data, [f.key]: e.target.value })}
              placeholder={f.label} />
          </div>
        ))}
      </div>
    </div>
  );
}

// Per-module row inside the validate card: name + verdict dropdown + detail toggle.
function ValidateModuleRow({ fillTi, verdict, onVerdict }) {
  const [showDetails, setShowDetails] = useState(false);
  const mod = getModule(fillTi.module);
  const name = fillTi.formData?.name || '(no name yet)';
  const zip  = fillTi.formData?.zip  || '';
  const fields = mod ? mod.fields : [];

  return (
    <div className="border border-slate-200 rounded-xl overflow-hidden bg-white">
      <div className="flex items-center gap-3 px-3 py-2.5">
        <span className="text-xs font-bold text-slate-500 uppercase w-14 shrink-0">{fillTi.module}</span>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-slate-700 truncate">{name}</div>
          {zip && <div className="text-[11px] text-slate-400">ZIP {zip}</div>}
        </div>

        {/* true / false verdict dropdown */}
        <select
          value={verdict === true ? 'true' : verdict === false ? 'false' : ''}
          onChange={e => onVerdict(e.target.value === 'true' ? true : e.target.value === 'false' ? false : null)}
          className={`text-xs font-semibold px-2 py-1.5 rounded-lg border focus:outline-none focus:ring-2 focus:ring-violet-400 ${
            verdict === true  ? 'bg-green-50 border-green-300 text-green-700' :
            verdict === false ? 'bg-rose-50 border-rose-300 text-rose-700' :
            'bg-slate-50 border-slate-200 text-slate-500'
          }`}
        >
          <option value="">— decide —</option>
          <option value="true">✓ Valid</option>
          <option value="false">✗ Invalid</option>
        </select>

        {/* details toggle */}
        <button
          onClick={() => setShowDetails(s => !s)}
          className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 shrink-0"
          title="View filled details">
          {showDetails ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
      </div>

      {showDetails && (
        <div className="border-t border-slate-100 px-3 py-2 bg-slate-50/60 grid grid-cols-2 gap-x-4 gap-y-1">
          {fields.map(f => (
            <div key={f.key} className="flex flex-col">
              <span className="text-[10px] text-slate-400 uppercase tracking-wide">{f.label}</span>
              <span className={`text-xs font-medium ${fillTi.formData?.[f.key] ? 'text-slate-700' : 'text-rose-400 italic'}`}>
                {fillTi.formData?.[f.key] || (f.required ? 'missing' : '—')}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ActionCard({ item, onComplete }) {
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState('');
  const [form, setForm] = useState(item.formData || {});
  const [loading, setLoading] = useState(false);
  // verdicts: { [taskInstanceId]: true | false | null }
  const [verdicts, setVerdicts] = useState({});

  const isFill = item.taskKind === 'fill' || item.taskKind === 'fix';
  const isValidate = item.taskKind === 'validate';
  const isReview = item.taskKind === 'review-record'
    || item.taskKind === 'manual-create-patient' || item.taskKind === 'manual-create-order';
  const kindBadge = {
    fill: 'create / fill', validate: 'validate', map: 'map to SA', fix: 'fix data',
    'review-record': 'review record',
    'manual-create-patient': 'create patient (PDF ref)',
    'manual-create-order': 'create admission/episode/order (PDF ref)',
  }[item.taskKind];

  // Resolve fill tasks from the live instance so we always have up-to-date formData.
  const fillTasks = (() => {
    if (!isValidate) return [];
    const inst = getInstance(item.instanceId);
    if (!inst) return [];
    const prereqs = inst.taskInstances.find(t => t.id === item.taskInstanceId);
    const prereqIds = Array.isArray(prereqs?.PreReq) ? prereqs.PreReq : [];
    return inst.taskInstances.filter(t => prereqIds.includes(t.stepId) && t.taskKind === 'fill');
  })();

  // Initialise verdicts from auto-check once we know the fill tasks.
  useEffect(() => {
    if (!isValidate || fillTasks.length === 0) return;
    const init = {};
    fillTasks.forEach(ft => {
      init[ft.id] = validateRecord(ft.module, ft.formData).ok;
    });
    setVerdicts(init);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.taskInstanceId]);

  const allDecided = isValidate ? fillTasks.every(ft => verdicts[ft.id] !== undefined && verdicts[ft.id] !== null) : true;

  async function handleComplete() {
    setLoading(true);
    if (isFill && item.taskInstanceId) {
      setTaskFormData(item.instanceId, item.taskInstanceId, form);
    }
    await new Promise(r => setTimeout(r, 200));
    onComplete(item, notes, isValidate ? verdicts : undefined);
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
            {kindBadge && <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-violet-100 text-violet-700">{kindBadge}</span>}
            <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-amber-100 text-amber-700">in progress</span>
          </div>
          {item.description && (
            <div className="text-xs text-slate-500 mt-1 leading-snug">{item.description}</div>
          )}
          <div className="flex items-center gap-2 mt-1.5 flex-wrap text-xs text-slate-400">
            <span className="font-medium text-slate-500">{item.workflowName}</span>
            <span className="text-slate-300">·</span>
            <span className="flex items-center gap-1">
              <Clock size={10} />
              {new Date(item.launchedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
            </span>
          </div>
        </div>
        <button
          onClick={() => setOpen(o => !o)}
          className={`shrink-0 px-3 py-1.5 rounded-xl text-sm font-medium flex items-center gap-1 transition-colors ${open ? 'bg-violet-600 text-white' : 'bg-violet-50 text-violet-700 hover:bg-violet-100'}`}>
          {open ? 'Cancel' : (isFill ? 'Open' : 'Review')}
          {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </button>
      </div>

      {open && (
        <div className="border-t border-slate-100 px-4 pb-4 bg-slate-50/50">
          <div className="pt-3 space-y-3">
            {isFill && item.module && (
              <FillForm module={item.module} data={form} onChange={setForm} />
            )}

            {isValidate && fillTasks.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-semibold text-slate-600 uppercase tracking-wide">Review each record</p>
                {fillTasks.map(ft => (
                  <ValidateModuleRow
                    key={ft.id}
                    fillTi={ft}
                    verdict={verdicts[ft.id] ?? null}
                    onVerdict={v => setVerdicts(prev => ({ ...prev, [ft.id]: v }))}
                  />
                ))}
              </div>
            )}

            {isValidate && fillTasks.length === 0 && (
              <div className="text-xs text-slate-500 bg-white border border-slate-200 rounded-xl p-3">
                No fill tasks found for this validation step.
              </div>
            )}

            {isReview && (
              <div className="space-y-2">
                <p className="text-xs font-semibold text-slate-600 uppercase tracking-wide">Record from the upload</p>
                <RecordView patient={item.patientRecord} orders={item.allOrders} order={item.orderRecord} />
                <p className="text-[11px] text-slate-400">
                  {item.taskKind === 'manual-create-patient'
                    ? 'Some patient fields were missing in the upload. Create the patient using the order-PDF reference, then mark it created to continue the loop.'
                    : item.taskKind === 'manual-create-order'
                    ? 'The admission/episode could not be auto-resolved. Create the admission/episode/order from the order-PDF reference, then mark it created.'
                    : 'Confirm this record looks correct to finish this patient and continue.'}
                </p>
              </div>
            )}

            {!isFill && !isValidate && !isReview && (
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1.5 uppercase tracking-wide">Notes / Output</label>
                <textarea
                  className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-400 resize-none bg-white"
                  rows={2} value={notes} onChange={e => setNotes(e.target.value)}
                  placeholder="Add notes, decisions, or output..." />
              </div>
            )}

            <button onClick={handleComplete} disabled={loading || (isValidate && !allDecided)}
              className="flex items-center gap-2 px-4 py-2.5 bg-green-600 text-white rounded-xl hover:bg-green-700 text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
              <CheckCircle2 size={16} />
              {loading ? 'Saving...' : isFill ? 'Submit & Complete' : isValidate ? 'Submit Validation'
                : (item.taskKind === 'manual-create-patient' || item.taskKind === 'manual-create-order') ? 'Mark created & continue'
                : isReview ? 'Confirm Record' : 'Mark Complete'}
            </button>
            {isValidate && !allDecided && (
              <p className="text-xs text-rose-500">Set a verdict (Valid / Invalid) for each record before submitting.</p>
            )}
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
        <span className="mx-1.5 text-slate-300">·</span>
        <span className="text-xs text-slate-400">{item.workflowName} › {item.taskName}</span>
      </div>
      <span className="text-xs text-slate-400 shrink-0">
        {new Date(item.completedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      </span>
    </div>
  );
}

const AVATAR_COLORS = [
  'bg-violet-200 text-violet-700',
  'bg-sky-200 text-sky-700',
  'bg-emerald-200 text-emerald-700',
  'bg-amber-200 text-amber-700',
];

export default function WorkBucket() {
  const { userId } = useParams();
  const navigate = useNavigate();
  const users = getUsers();
  const user = users.find(u => u.id === userId);
  const userIdx = users.findIndex(u => u.id === userId);

  const [pending, setPending] = useState([]);
  const [completed, setCompleted] = useState([]);

  const refresh = useCallback(() => {
    setPending(getMyWorkItems(userId));
    setCompleted(getMyCompletedItems(userId));
  }, [userId]);

  useEffect(() => {
    refresh();
    // re-read when user switches back to this tab
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <p className="text-slate-500 mb-4">User not found.</p>
          <button onClick={() => navigate('/')} className="text-violet-600 hover:underline text-sm">← Back</button>
        </div>
      </div>
    );
  }

  function handleComplete(item, notes, validationOverrides) {
    completeActionInstance(item.instanceId, item.taskInstanceId, item.actionInstanceId, notes, validationOverrides);
    refresh();
  }

  const avatarCls = AVATAR_COLORS[userIdx % AVATAR_COLORS.length];

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-100 sticky top-0 z-10">
        <div className="max-w-xl mx-auto px-4 py-3 flex items-center gap-3">
          <button onClick={() => navigate('/')} className="p-2 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors">
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

      <main className="max-w-xl mx-auto px-4 py-6 space-y-6">
        <section>
          <div className="flex items-center gap-2 mb-3">
            <span className="w-2 h-2 rounded-full bg-amber-400" />
            <h2 className="text-sm font-semibold text-slate-700">
              Pending
              {pending.length > 0 && (
                <span className="ml-2 px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 text-xs font-bold">{pending.length}</span>
              )}
            </h2>
          </div>

          {pending.length === 0 ? (
            <div className="text-center py-12 text-slate-400">
              <Inbox size={36} className="mx-auto mb-3 opacity-30" />
              <p className="font-medium text-slate-500">You're all caught up!</p>
              <p className="text-xs mt-1">No pending tasks right now.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {pending.map(item => (
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
              {completed.map(item => (
                <CompletedCard key={item.actionInstanceId} item={item} />
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
