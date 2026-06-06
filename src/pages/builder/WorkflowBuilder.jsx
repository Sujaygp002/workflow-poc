import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { ChevronRight, ChevronLeft, Plus, X, ChevronDown, ChevronUp, Check } from 'lucide-react';
import Badge from '../../components/Badge';
import { getUsers, getTasks, getActions, saveWorkflow } from '../../store';

const TRIGGER_TYPES = ['click', 'schedule', 'action', 'task', 'workflow'];
const CONDITION_TYPES = ['none', 'if/else', 'switch', 'loop'];
const EXECUTOR_TYPES = ['human', 'ai', 'system', 'human+ai', 'ai+system'];

const STEPS = ['Identity', 'Trigger', 'Tasks', 'Assign', 'Review'];

// ── Step 1: Workflow Identity ───────────────────────────
function StepIdentity({ data, onChange }) {
  const users = getUsers();
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
      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1">Owner</label>
        <select className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-400"
          value={data.owner} onChange={e => onChange({ ...data, owner: e.target.value })}>
          <option value="">— Select owner —</option>
          {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
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
            <button type="button" key={t} onClick={() => onChange({ ...data, triggerType: t, triggerConfig: '' })}
              className={`px-4 py-3 rounded-xl border text-sm font-medium transition-all text-left ${data.triggerType === t ? 'bg-violet-600 text-white border-violet-600 shadow-sm' : 'border-slate-200 text-slate-600 hover:border-violet-300 bg-white'}`}>
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
      {data.triggerType && data.triggerType !== 'click' && (
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">
            {data.triggerType === 'schedule' ? 'Cron expression or time' : 'Event / source name'}
          </label>
          <input className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-400"
            value={data.triggerConfig} onChange={e => onChange({ ...data, triggerConfig: e.target.value })}
            placeholder={data.triggerType === 'schedule' ? '0 9 * * MON-FRI' : 'e.g. invoice.submitted'} />
        </div>
      )}
    </div>
  );
}

// ── Step 3: Task Pipeline ──────────────────────────────
function InlineActionEditor({ actions, onChange }) {
  const users = getUsers();
  const allActions = getActions();
  const [mode, setMode] = useState('pick');
  const [newAct, setNewAct] = useState({ name: '', executorType: 'human', assignedTo: '' });

  function addNew() {
    if (!newAct.name) return;
    const a = { ...newAct, id: Math.random().toString(36).slice(2) };
    onChange([...actions, a]);
    setNewAct({ name: '', executorType: 'human', assignedTo: '' });
    setMode('pick');
  }

  function remove(id) { onChange(actions.filter(a => a.id !== id)); }

  function updateAssign(id, userId) {
    onChange(actions.map(a => a.id === id ? { ...a, assignedTo: userId } : a));
  }

  function pickExisting(action) {
    if (actions.find(a => a.id === action.id)) return;
    onChange([...actions, { ...action }]);
  }

  return (
    <div className="space-y-2">
      {actions.length > 0 && (
        <div className="space-y-1">
          {actions.map(a => {
            const user = users.find(u => u.id === a.assignedTo);
            return (
              <div key={a.id} className="flex items-center gap-2 bg-violet-50 border border-violet-100 rounded-lg px-3 py-2">
                <span className="flex-1 text-sm text-slate-700">{a.name}</span>
                <Badge label={a.executorType} type={a.executorType?.split('+')[0]} />
                {(a.executorType === 'human' || a.executorType === 'human+ai') && (
                  <select className="text-xs border border-slate-200 rounded px-2 py-1 bg-white focus:outline-none"
                    value={a.assignedTo || ''} onChange={e => updateAssign(a.id, e.target.value)}>
                    <option value="">— assign —</option>
                    {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                  </select>
                )}
                {user && <span className="text-xs text-slate-400">{user.name}</span>}
                <button type="button" onClick={() => remove(a.id)} className="text-slate-300 hover:text-red-400"><X size={13} /></button>
              </div>
            );
          })}
        </div>
      )}

      <div className="flex gap-2">
        <button type="button" onClick={() => setMode('pick')}
          className={`text-xs px-3 py-1 rounded-full border ${mode === 'pick' ? 'bg-violet-600 text-white border-violet-600' : 'border-slate-200 text-slate-500'}`}>
          From Registry
        </button>
        <button type="button" onClick={() => setMode('new')}
          className={`text-xs px-3 py-1 rounded-full border ${mode === 'new' ? 'bg-violet-600 text-white border-violet-600' : 'border-slate-200 text-slate-500'}`}>
          + New Action
        </button>
      </div>

      {mode === 'pick' && (
        <div className="border border-slate-200 rounded-lg overflow-hidden max-h-36 overflow-y-auto">
          {allActions.length === 0 && <div className="p-3 text-xs text-slate-400 text-center">No actions in registry</div>}
          {allActions.filter(a => !actions.find(s => s.id === a.id)).map(a => (
            <button type="button" key={a.id} onClick={() => pickExisting(a)}
              className="w-full flex items-center gap-2 px-3 py-2 hover:bg-violet-50 border-b border-slate-100 last:border-0 text-left">
              <span className="text-sm text-slate-700 flex-1">{a.name}</span>
              <Badge label={a.executorType} type={a.executorType?.split('+')[0]} />
            </button>
          ))}
        </div>
      )}

      {mode === 'new' && (
        <div className="border border-slate-200 rounded-lg p-3 space-y-2 bg-slate-50">
          <input className="w-full border border-slate-200 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-400"
            value={newAct.name} onChange={e => setNewAct(a => ({ ...a, name: e.target.value }))} placeholder="Action name" />
          <div className="flex flex-wrap gap-1">
            {EXECUTOR_TYPES.map(t => (
              <button type="button" key={t} onClick={() => setNewAct(a => ({ ...a, executorType: t }))}
                className={`text-xs px-2 py-0.5 rounded-full border ${newAct.executorType === t ? 'bg-violet-600 text-white border-violet-600' : 'border-slate-200 text-slate-500'}`}>
                {t}
              </button>
            ))}
          </div>
          {(newAct.executorType === 'human' || newAct.executorType === 'human+ai') && (
            <select className="w-full border border-slate-200 rounded px-3 py-1.5 text-sm focus:outline-none"
              value={newAct.assignedTo} onChange={e => setNewAct(a => ({ ...a, assignedTo: e.target.value }))}>
              <option value="">— assign to —</option>
              {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          )}
          <button type="button" onClick={addNew} disabled={!newAct.name}
            className="w-full py-1.5 text-xs bg-violet-600 text-white rounded-lg hover:bg-violet-700 disabled:opacity-40">
            Add Action
          </button>
        </div>
      )}
    </div>
  );
}

function TaskBuilder({ tasks, onChange }) {
  const allTasks = getTasks();
  const [expandedIdx, setExpandedIdx] = useState(null);

  function addFromRegistry(task) {
    if (tasks.find(t => t.id === task.id)) return;
    onChange([...tasks, { ...task, _instanceId: Math.random().toString(36).slice(2) }]);
  }

  function addNew() {
    const t = {
      _instanceId: Math.random().toString(36).slice(2),
      id: null,
      name: 'New Task',
      description: '',
      executionMode: 'sequential',
      condition: 'none',
      conditionExpr: '',
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
    const updated = tasks.filter((_, i) => i !== idx);
    onChange(updated);
    if (expandedIdx === idx) setExpandedIdx(null);
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
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">Execution Mode</label>
                    <div className="flex gap-2">
                      {['sequential', 'parallel'].map(m => (
                        <button type="button" key={m} onClick={() => update(idx, { executionMode: m })}
                          className={`flex-1 px-3 py-2 rounded-lg text-xs font-medium border transition-all ${(task.executionMode || 'sequential') === m ? 'bg-violet-600 text-white border-violet-600' : 'border-slate-200 text-slate-500 hover:border-violet-300'}`}>
                          <span className="block capitalize font-semibold">{m}</span>
                          <span className="block opacity-70 mt-0.5">{m === 'sequential' ? 'one at a time →' : 'all at once ⫶'}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">Control Flow (after task)</label>
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
                        placeholder={task.condition === 'loop' ? 'e.g. repeat 3 times' : 'e.g. amount > 1000'} />
                    )}
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-2">Actions</label>
                    <InlineActionEditor actions={task.actions || []} onChange={v => update(idx, { actions: v })} />
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
                <button type="button" key={t.id} onClick={() => addFromRegistry(t)}
                  className="w-full text-left px-4 py-2 text-sm hover:bg-violet-50 text-slate-700 border-b border-slate-100 last:border-0">
                  {t.name}
                  <span className="ml-2 text-xs text-slate-400">{t.actions?.length || 0} actions</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Step 4: Assign ─────────────────────────────────────
function StepAssign({ tasks, onChange }) {
  const users = getUsers();

  function updateAssign(taskIdx, actionId, userId) {
    const updated = tasks.map((t, ti) => {
      if (ti !== taskIdx) return t;
      return {
        ...t,
        actions: (t.actions || []).map(a => a.id === actionId ? { ...a, assignedTo: userId } : a),
      };
    });
    onChange(updated);
  }

  const humanActions = tasks.flatMap((t, ti) =>
    (t.actions || [])
      .filter(a => a.executorType === 'human' || a.executorType === 'human+ai')
      .map(a => ({ taskIdx: ti, taskName: t.name, action: a }))
  );

  if (humanActions.length === 0) {
    return (
      <div className="text-center py-10 text-slate-400">
        <p>No human-assigned actions in this workflow.</p>
        <p className="text-sm mt-1">All actions are automated (AI / System).</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-500">Assign each human action to a team member:</p>
      {humanActions.map(({ taskIdx, taskName, action }) => (
        <div key={`${taskIdx}-${action.id}`} className="bg-white border border-slate-100 rounded-xl p-4 flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <div className="text-xs text-slate-400 mb-0.5">{taskName}</div>
            <div className="font-medium text-slate-800 text-sm">{action.name}</div>
            <Badge label={action.executorType} type={action.executorType?.split('+')[0]} />
          </div>
          <select className="border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-400"
            value={action.assignedTo || ''} onChange={e => updateAssign(taskIdx, action.id, e.target.value)}>
            <option value="">— assign to —</option>
            {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </div>
      ))}
    </div>
  );
}

// ── Step 5: Review ─────────────────────────────────────
function StepReview({ data }) {
  const users = getUsers();
  const owner = users.find(u => u.id === data.owner);

  return (
    <div className="space-y-4">
      <div className="bg-slate-50 rounded-xl p-4 space-y-2">
        <div className="flex justify-between text-sm">
          <span className="text-slate-500">Name</span>
          <span className="font-medium text-slate-800">{data.name}</span>
        </div>
        {data.description && (
          <div className="flex justify-between text-sm">
            <span className="text-slate-500">Description</span>
            <span className="text-slate-700 text-right max-w-xs">{data.description}</span>
          </div>
        )}
        <div className="flex justify-between text-sm">
          <span className="text-slate-500">Owner</span>
          <span className="font-medium text-slate-800">{owner?.name || '—'}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-slate-500">Trigger</span>
          <div className="flex items-center gap-2">
            <Badge label={data.triggerType} type={data.triggerType} />
            {data.triggerConfig && <span className="text-xs text-slate-500">{data.triggerConfig}</span>}
          </div>
        </div>
      </div>

      <div>
        <h3 className="text-sm font-semibold text-slate-700 mb-2">Tasks ({data.tasks?.length || 0})</h3>
        {(data.tasks || []).map((t, i) => (
          <div key={i} className="mb-2 bg-white border border-slate-100 rounded-lg p-3">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-bold text-violet-600">{i + 1}</span>
              <span className="font-medium text-slate-800 text-sm">{t.name}</span>
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${(t.executionMode || 'sequential') === 'parallel' ? 'bg-teal-100 text-teal-700' : 'bg-slate-100 text-slate-600'}`}>
                {t.executionMode || 'sequential'}
              </span>
              {t.condition !== 'none' && <Badge label={t.condition} />}
            </div>
            {(t.actions || []).map(a => {
              const user = users.find(u => u.id === a.assignedTo);
              return (
                <div key={a.id} className="mt-1 ml-4 flex items-center gap-2 text-xs text-slate-600">
                  <span className="w-1 h-1 rounded-full bg-slate-300" />
                  {a.name}
                  <Badge label={a.executorType} type={a.executorType?.split('+')[0]} />
                  {user && <span className="text-slate-400">→ {user.name}</span>}
                  {!user && (a.executorType === 'ai' || a.executorType === 'system') && (
                    <span className="text-slate-400 italic">auto</span>
                  )}
                </div>
              );
            })}
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
    : { name: '', description: '', owner: '', triggerType: 'click', triggerConfig: '', tasks: [] }
  );

  function canNext() {
    if (step === 0) return !!wf.name.trim();
    if (step === 1) return !!wf.triggerType;
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
        {step === 3 && <StepAssign tasks={wf.tasks} onChange={tasks => setWf(w => ({ ...w, tasks }))} />}
        {step === 4 && <StepReview data={wf} />}
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
