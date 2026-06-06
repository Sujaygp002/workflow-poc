import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { ChevronRight, ChevronLeft, Plus, X, ChevronDown, ChevronUp, Check } from 'lucide-react';
import Badge from '../../components/Badge';
import { getTasks, getActions, saveWorkflow } from '../../store';

const TRIGGER_TYPES = ['click', 'schedule', 'action', 'task', 'workflow'];
const CONDITION_TYPES = ['none', 'if/else', 'switch', 'loop'];

const STEPS = ['Identity', 'Trigger', 'Tasks', 'Review'];

// ── Step 1: Workflow Identity ───────────────────────────
function StepIdentity({ data, onChange }) {
  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1">Workflow Name *</label>
        <input className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-400"
          value={data.name} onChange={e => onChange({ ...data, name: e.target.value })}
          placeholder="e.g. Invoice Approval" />
      </div>
      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1">Description</label>
        <textarea className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-400 resize-none"
          rows={3} value={data.description} onChange={e => onChange({ ...data, description: e.target.value })} />
      </div>
    </div>
  );
}

// ── Step 2: Trigger ────────────────────────────────────
function StepTrigger({ data, onChange }) {
  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-slate-700 mb-2">Trigger Type *</label>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {TRIGGER_TYPES.map(t => (
            <button type="button" key={t} onClick={() => onChange({ ...data, trigger: t, triggerConfig: '' })}
              className={`px-4 py-3 rounded-xl border text-sm font-medium transition-all text-left ${data.trigger === t ? 'bg-violet-600 text-white border-violet-600 shadow-sm' : 'border-slate-200 text-slate-600 hover:border-violet-300 bg-white'}`}>
              <span className="block capitalize">{t}</span>
              <span className="block text-xs mt-0.5 opacity-70">
                {t === 'click' && 'Manual button'}
                {t === 'schedule' && 'Cron / time'}
                {t === 'action' && 'On action event'}
                {t === 'task' && 'On task event'}
                {t === 'workflow' && 'On workflow event'}
              </span>
            </button>
          ))}
        </div>
      </div>
      {data.trigger && data.trigger !== 'click' && (
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">
            {data.trigger === 'schedule' ? 'Cron expression or time' : 'Event / source name'}
          </label>
          <input className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-400"
            value={data.triggerConfig} onChange={e => onChange({ ...data, triggerConfig: e.target.value })}
            placeholder={data.trigger === 'schedule' ? '0 9 * * MON-FRI' : 'e.g. invoice.submitted'} />
        </div>
      )}
    </div>
  );
}

// ── Step 3: Task Pipeline ──────────────────────────────
function InlineActionEditor({ actions, onChange }) {
  const allActions = getActions();
  const [mode, setMode] = useState('new');
  const [newName, setNewName] = useState('');

  function addNew() {
    if (!newName.trim()) return;
    const a = { id: Math.random().toString(36).slice(2), name: newName.trim(), executorType: 'human' };
    onChange([...actions, a]);
    setNewName('');
  }

  function remove(id) { onChange(actions.filter(a => a.id !== id)); }

  function pickExisting(action) {
    if (actions.find(a => a.id === action.id)) return;
    onChange([...actions, { ...action }]);
  }

  return (
    <div className="space-y-2">
      {actions.length > 0 && (
        <div className="space-y-1">
          {actions.map((a, i) => (
            <div key={a.id} className="flex items-center gap-2 bg-violet-50 border border-violet-100 rounded-lg px-3 py-2">
              <span className="text-xs text-slate-400 w-4 shrink-0">{i + 1}</span>
              <span className="flex-1 text-sm text-slate-700">{a.name}</span>
              <button type="button" onClick={() => remove(a.id)} className="text-slate-300 hover:text-red-400"><X size={13} /></button>
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-2">
        <button type="button" onClick={() => setMode('new')}
          className={`text-xs px-3 py-1 rounded-full border ${mode === 'new' ? 'bg-violet-600 text-white border-violet-600' : 'border-slate-200 text-slate-500'}`}>
          + New Step
        </button>
        {allActions.length > 0 && (
          <button type="button" onClick={() => setMode('pick')}
            className={`text-xs px-3 py-1 rounded-full border ${mode === 'pick' ? 'bg-violet-600 text-white border-violet-600' : 'border-slate-200 text-slate-500'}`}>
            From Registry
          </button>
        )}
      </div>

      {mode === 'new' && (
        <div className="flex gap-2">
          <input className="flex-1 border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-400"
            value={newName} onChange={e => setNewName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && addNew()}
            placeholder="Step name, e.g. Review Document" />
          <button type="button" onClick={addNew} disabled={!newName.trim()}
            className="px-3 py-1.5 text-xs bg-violet-600 text-white rounded-lg hover:bg-violet-700 disabled:opacity-40">
            Add
          </button>
        </div>
      )}

      {mode === 'pick' && (
        <div className="border border-slate-200 rounded-lg overflow-hidden max-h-36 overflow-y-auto">
          {allActions.filter(a => !actions.find(s => s.id === a.id)).map(a => (
            <button type="button" key={a.id} onClick={() => pickExisting(a)}
              className="w-full flex items-center gap-2 px-3 py-2 hover:bg-violet-50 border-b border-slate-100 last:border-0 text-left">
              <span className="text-sm text-slate-700 flex-1">{a.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function TaskBuilder({ tasks, onChange }) {
  const allTasks = getTasks();
  const [expandedIdx, setExpandedIdx] = useState(null);

  function addNew() {
    const t = {
      _instanceId: Math.random().toString(36).slice(2),
      id: null,
      name: 'New Task',
      description: '',
      PreReq: 'none',
      condition: 'none',
      conditionExpr: '',
      branches: [],
      Tasksteps: [],
      actions: [],
    };
    onChange([...tasks, t]);
    setExpandedIdx(tasks.length);
  }

  function update(idx, patch) {
    const updated = [...tasks];
    updated[idx] = { ...updated[idx], ...patch };
    onChange(updated);
  }

  function remove(idx) {
    onChange(tasks.filter((_, i) => i !== idx));
    if (expandedIdx === idx) setExpandedIdx(null);
  }

  // keep Tasksteps in sync with actions
  function updateActions(idx, newActions) {
    update(idx, {
      actions: newActions,
      Tasksteps: newActions.map(a => a.name),
    });
  }

  const availableFromRegistry = allTasks.filter(t => !tasks.find(s => s.id === t.id));

  return (
    <div className="space-y-3">
      {tasks.length > 0 && (
        <div className="space-y-2">
          {tasks.map((task, idx) => (
            <div key={task._instanceId || task.id || idx} className="border border-slate-200 rounded-xl overflow-hidden bg-white">
              <div className="flex items-center gap-2 px-4 py-3">
                <span className="w-6 h-6 rounded-full bg-violet-100 text-violet-700 text-xs font-bold flex items-center justify-center shrink-0">
                  {idx + 1}
                </span>
                <input className="flex-1 text-sm font-medium text-slate-800 focus:outline-none bg-transparent"
                  value={task.name} onChange={e => update(idx, { name: e.target.value })} />
                {task.condition !== 'none' && <Badge label={task.condition} />}
                <button type="button" onClick={() => setExpandedIdx(expandedIdx === idx ? null : idx)} className="text-slate-400 hover:text-violet-600">
                  {expandedIdx === idx ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                </button>
                <button type="button" onClick={() => remove(idx)} className="text-slate-300 hover:text-red-400"><X size={15} /></button>
              </div>

              {expandedIdx === idx && (
                <div className="border-t border-slate-100 px-4 pb-4 space-y-3 bg-slate-50/50">
                  <div className="pt-3">
                    <label className="block text-xs font-medium text-slate-600 mb-1">Description</label>
                    <input className="w-full border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-400"
                      value={task.description} onChange={e => update(idx, { description: e.target.value })} />
                  </div>

                  {/* PreReq */}
                  {idx > 0 && (
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1">Pre-requisite tasks</label>
                      <div className="flex flex-wrap gap-1.5">
                        {tasks.slice(0, idx).map((t, ti) => {
                          const selected = Array.isArray(task.PreReq) && task.PreReq.includes(t.id || t._instanceId);
                          return (
                            <button type="button" key={ti}
                              onClick={() => {
                                const tid = t.id || t._instanceId;
                                const current = Array.isArray(task.PreReq) ? task.PreReq : [];
                                update(idx, { PreReq: selected ? current.filter(x => x !== tid) : [...current, tid] });
                              }}
                              className={`text-xs px-2.5 py-1 rounded-full border ${selected ? 'bg-violet-600 text-white border-violet-600' : 'border-slate-200 text-slate-500 hover:border-violet-300'}`}>
                              {t.name}
                            </button>
                          );
                        })}
                        <button type="button"
                          onClick={() => update(idx, { PreReq: 'none' })}
                          className={`text-xs px-2.5 py-1 rounded-full border ${task.PreReq === 'none' ? 'bg-slate-600 text-white border-slate-600' : 'border-slate-200 text-slate-400'}`}>
                          none
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Condition */}
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">Condition ◆</label>
                    <div className="flex flex-wrap gap-1.5">
                      {CONDITION_TYPES.map(c => (
                        <button type="button" key={c} onClick={() => update(idx, { condition: c })}
                          className={`px-2.5 py-1 rounded-full text-xs border ${task.condition === c ? 'bg-violet-600 text-white border-violet-600' : 'border-slate-200 text-slate-500'}`}>
                          {c}
                        </button>
                      ))}
                    </div>
                    {task.condition !== 'none' && (
                      <input className="mt-2 w-full border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-400"
                        value={task.conditionExpr} onChange={e => update(idx, { conditionExpr: e.target.value })}
                        placeholder={task.condition === 'loop' ? 'e.g. resolvedCount < 8 → repeat' : 'e.g. amount > 1000'} />
                    )}
                  </div>

                  {/* Task steps (actions) */}
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-2">Task Steps</label>
                    <InlineActionEditor actions={task.actions || []} onChange={v => updateActions(idx, v)} />
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-2">
        <button type="button" onClick={addNew}
          className="flex items-center gap-1.5 px-3 py-2 text-sm border-2 border-dashed border-violet-300 rounded-xl text-violet-600 hover:bg-violet-50 transition-colors">
          <Plus size={14} /> New Task
        </button>
        {availableFromRegistry.length > 0 && (
          <div className="relative group">
            <button type="button" className="flex items-center gap-1.5 px-3 py-2 text-sm border-2 border-dashed border-slate-200 rounded-xl text-slate-500 hover:border-violet-300 hover:text-violet-600 transition-colors">
              <Plus size={14} /> From Registry
            </button>
            <div className="hidden group-hover:block absolute top-full left-0 mt-1 bg-white border border-slate-200 rounded-xl shadow-lg z-10 min-w-48 overflow-hidden">
              {availableFromRegistry.map(t => (
                <button type="button" key={t.id} onClick={() => {
                  const withInstance = { ...t, _instanceId: Math.random().toString(36).slice(2) };
                  onChange([...tasks, withInstance]);
                }}
                  className="w-full text-left px-4 py-2 text-sm hover:bg-violet-50 text-slate-700 border-b border-slate-100 last:border-0">
                  {t.name}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Step 4: Review ─────────────────────────────────────
function StepReview({ data }) {
  const condColors = {
    'if/else': 'bg-amber-100 text-amber-700',
    'switch':  'bg-blue-100 text-blue-700',
    'loop':    'bg-purple-100 text-purple-700',
  };

  return (
    <div className="space-y-4">
      <div className="bg-slate-50 rounded-xl p-4 space-y-2">
        <div className="flex justify-between text-sm">
          <span className="text-slate-500">Name</span>
          <span className="font-medium text-slate-800">{data.name}</span>
        </div>
        {data.description && (
          <div className="flex justify-between text-sm gap-4">
            <span className="text-slate-500 shrink-0">Description</span>
            <span className="text-slate-700 text-right">{data.description}</span>
          </div>
        )}
        <div className="flex justify-between text-sm">
          <span className="text-slate-500">Trigger</span>
          <div className="flex items-center gap-2">
            <Badge label={data.trigger} type={data.trigger} />
            {data.triggerConfig && <span className="text-xs text-slate-500 font-mono">{data.triggerConfig}</span>}
          </div>
        </div>
      </div>

      <div>
        <h3 className="text-sm font-semibold text-slate-700 mb-2">Tasks ({data.tasks?.length || 0})</h3>
        {(data.tasks || []).map((t, i) => (
          <div key={i} className="mb-2 bg-white border border-slate-100 rounded-lg p-3">
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <span className="text-xs font-bold text-violet-600">{i + 1}</span>
              <span className="font-medium text-slate-800 text-sm">{t.name}</span>
              {t.condition !== 'none' && (
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${condColors[t.condition] || 'bg-slate-100 text-slate-600'}`}>
                  ◆ {t.condition} {t.conditionExpr && `· ${t.conditionExpr}`}
                </span>
              )}
              {Array.isArray(t.PreReq) && t.PreReq.length > 0 && (
                <span className="text-xs text-slate-400">after {t.PreReq.length} task{t.PreReq.length > 1 ? 's' : ''}</span>
              )}
            </div>
            {(t.Tasksteps || []).map((step, si) => (
              <div key={si} className="ml-4 flex items-center gap-2 text-xs text-slate-600 mt-0.5">
                <span className="w-1 h-1 rounded-full bg-slate-300" />
                {step}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Main Wizard ────────────────────────────────────────
export default function WorkflowBuilder() {
  const navigate = useNavigate();
  const location = useLocation();
  const existing = location.state?.workflow || null;
  const isEditing = !!existing;

  const [step, setStep] = useState(0);
  const [wf, setWf] = useState(() => existing
    ? { ...existing, tasks: (existing.tasks || []).map(t => ({ ...t, _instanceId: t._instanceId || Math.random().toString(36).slice(2) })) }
    : { name: '', description: '', trigger: 'click', triggerConfig: '', tasks: [] }
  );

  function canNext() {
    if (step === 0) return !!wf.name.trim();
    if (step === 1) return !!wf.trigger;
    return true;
  }

  function handleSave() {
    saveWorkflow(wf);
    navigate('/builder/workflows');
  }

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <div className="flex items-center gap-2 mb-6">
        <button type="button" onClick={() => navigate('/builder/workflows')}
          className="text-sm text-slate-400 hover:text-slate-600">
          ← Workflows
        </button>
        <span className="text-slate-300">/</span>
        <span className="text-sm text-slate-600 font-medium">{isEditing ? `Edit: ${wf.name}` : 'New Workflow'}</span>
      </div>

      {/* Step indicator */}
      <div className="flex items-center gap-1 mb-8">
        {STEPS.map((s, i) => (
          <div key={s} className="flex items-center gap-1 flex-1">
            <button type="button" onClick={() => i < step && setStep(i)}
              className={`flex items-center justify-center w-7 h-7 rounded-full text-xs font-bold transition-colors ${i < step ? 'bg-violet-600 text-white cursor-pointer' : i === step ? 'bg-violet-600 text-white ring-4 ring-violet-100 cursor-default' : 'bg-slate-100 text-slate-400 cursor-default'}`}>
              {i < step ? <Check size={13} /> : i + 1}
            </button>
            <span className={`text-xs hidden sm:block ${i === step ? 'text-violet-600 font-medium' : 'text-slate-400'}`}>{s}</span>
            {i < STEPS.length - 1 && <div className={`flex-1 h-px mx-1 ${i < step ? 'bg-violet-300' : 'bg-slate-200'}`} />}
          </div>
        ))}
      </div>

      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-6 mb-6">
        <h2 className="text-lg font-semibold text-slate-800 mb-4">{STEPS[step]}</h2>
        {step === 0 && <StepIdentity data={wf} onChange={setWf} />}
        {step === 1 && <StepTrigger data={wf} onChange={setWf} />}
        {step === 2 && <TaskBuilder tasks={wf.tasks} onChange={tasks => setWf(w => ({ ...w, tasks }))} />}
        {step === 3 && <StepReview data={wf} />}
      </div>

      <div className="flex justify-between">
        <button type="button" onClick={() => setStep(s => s - 1)} disabled={step === 0}
          className="flex items-center gap-2 px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-lg disabled:opacity-0 transition-colors">
          <ChevronLeft size={16} /> Back
        </button>
        {step < STEPS.length - 1 ? (
          <button type="button" onClick={() => setStep(s => s + 1)} disabled={!canNext()}
            className="flex items-center gap-2 px-5 py-2 bg-violet-600 text-white rounded-lg hover:bg-violet-700 disabled:opacity-40 text-sm font-medium">
            Next <ChevronRight size={16} />
          </button>
        ) : (
          <button type="button" onClick={handleSave} disabled={!wf.name.trim()}
            className="flex items-center gap-2 px-5 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-40 text-sm font-medium">
            <Check size={16} /> {isEditing ? 'Save Changes' : 'Save Workflow'}
          </button>
        )}
      </div>
    </div>
  );
}
