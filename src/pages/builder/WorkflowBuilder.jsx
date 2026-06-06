import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { ChevronRight, ChevronLeft, Plus, X, ChevronDown, ChevronUp, Check, Zap, CheckCircle2 } from 'lucide-react';
import {
  saveWorkflow,
  getTriggers,
  getWorkflowForTrigger,
  getObjectSets,
} from '../../store';

const STEPS = ['Trigger', 'Identity', 'Steps', 'Review'];

const STEP_TYPES = [
  { id: 'task',        label: 'Task',        icon: '▸', desc: 'Work to be done', color: 'violet' },
  { id: 'conditional', label: 'Conditional', icon: '◆', desc: 'Branch / decision', color: 'amber' },
  { id: 'loop',        label: 'Loop',        icon: '↻', desc: 'For each item in a set', color: 'purple' },
];

const CONDITION_KINDS = ['if/else', 'switch'];

function typeMeta(type) {
  return STEP_TYPES.find(t => t.id === type) || STEP_TYPES[0];
}

const typeBadgeCls = {
  task:        'bg-violet-100 text-violet-700',
  conditional: 'bg-amber-100 text-amber-700',
  loop:        'bg-purple-100 text-purple-700',
};

// ── Branch routing helpers ─────────────────────────────
function stepKey(t) { return t.id || t._id; }

// Tasks/loops a conditional's branch can route to (any non-conditional step
// other than itself).
function branchTargetOptions(steps, condIdx) {
  return steps.filter((t, i) => i !== condIdx && t.type !== 'conditional');
}

// Keep the human-readable `branches` labels and the target tasks' PreReq in
// sync with the picked trueTarget / falseTarget. Returns the patched step;
// PreReq wiring is applied by syncBranches' caller via the returned step.
function syncBranches(step, steps) {
  const nameOf = id => {
    const t = steps.find(s => stepKey(s) === id);
    return t ? t.name : '';
  };
  const branches = [];
  if (step.falseTarget) branches.push(`false → ${nameOf(step.falseTarget)}`);
  if (step.trueTarget)  branches.push(`true → ${nameOf(step.trueTarget)}`);
  return { ...step, branches };
}

// ── Step 1: Trigger selection ──────────────────────────
function StepTrigger({ data, onChange, workflows }) {
  const triggers = getTriggers();

  function isMapped(t) {
    if (!t.workflowId) return false;
    return !!workflows.find(w => w.id === t.workflowId);
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-500">
        Pick a trigger to build its workflow. Triggers without a workflow yet are highlighted — those are the ones to set up.
      </p>
      <div className="grid sm:grid-cols-2 gap-2">
        {triggers.map(t => {
          const mapped = isMapped(t);
          const selected = data.triggerId === t.id;
          return (
            <button type="button" key={t.id}
              onClick={() => onChange({ ...data, triggerId: t.id })}
              className={`text-left px-4 py-3 rounded-xl border transition-all relative ${
                selected
                  ? 'bg-violet-600 text-white border-violet-600 shadow-sm'
                  : mapped
                    ? 'border-slate-200 bg-white text-slate-600 hover:border-violet-300'
                    : 'border-amber-300 bg-amber-50 text-amber-800 hover:border-amber-400 ring-1 ring-amber-100'
              }`}>
              <div className="flex items-center gap-2">
                <Zap size={13} className={selected ? 'text-white' : mapped ? 'text-violet-500' : 'text-amber-500'} />
                <span className="font-semibold text-sm">{t.name}</span>
                <span className={`text-xs ${selected ? 'text-violet-100' : 'opacity-60'}`}>{t.label}</span>
              </div>
              <div className={`text-xs mt-1 ${selected ? 'text-violet-100' : 'opacity-70'}`}>{t.description}</div>
              <div className="mt-1.5">
                {mapped ? (
                  <span className={`text-[10px] font-medium inline-flex items-center gap-1 ${selected ? 'text-violet-100' : 'text-slate-400'}`}>
                    <CheckCircle2 size={10} /> has workflow{selected ? ' — will overwrite' : ''}
                  </span>
                ) : (
                  <span className={`text-[10px] font-bold ${selected ? 'text-white' : 'text-amber-600'}`}>
                    ● needs a workflow
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Step 2: Identity ───────────────────────────────────
function StepIdentity({ data, onChange }) {
  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1">Workflow Name *</label>
        <input className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-400"
          value={data.name} onChange={e => onChange({ ...data, name: e.target.value })}
          placeholder="e.g. Call Doctor" />
      </div>
      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1">Description</label>
        <textarea className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-400 resize-none"
          rows={3} value={data.description} onChange={e => onChange({ ...data, description: e.target.value })} />
      </div>
    </div>
  );
}

// ── Sub-step editor (display labels only) ──────────────
function SubStepEditor({ subSteps, onChange }) {
  const [newName, setNewName] = useState('');

  function add() {
    if (!newName.trim()) return;
    onChange([...subSteps, newName.trim()]);
    setNewName('');
  }
  function remove(i) { onChange(subSteps.filter((_, idx) => idx !== i)); }

  return (
    <div className="space-y-2">
      {subSteps.length > 0 && (
        <div className="space-y-1">
          {subSteps.map((s, i) => (
            <div key={i} className="flex items-center gap-2 bg-violet-50 border border-violet-100 rounded-lg px-3 py-2">
              <span className="text-xs text-slate-400 w-4 shrink-0">{i + 1}</span>
              <span className="flex-1 text-sm text-slate-700">{s}</span>
              <button type="button" onClick={() => remove(i)} className="text-slate-300 hover:text-red-400"><X size={13} /></button>
            </div>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <input className="flex-1 border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-400"
          value={newName} onChange={e => setNewName(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), add())}
          placeholder="Sub-step, e.g. Call Patient" />
        <button type="button" onClick={add} disabled={!newName.trim()}
          className="px-3 py-1.5 text-xs bg-violet-600 text-white rounded-lg hover:bg-violet-700 disabled:opacity-40">
          Add
        </button>
      </div>
    </div>
  );
}

// Dropdown to route a conditional branch to a specific task.
function BranchTargetPicker({ label, accent, value, tasks, onChange }) {
  const accentCls = accent === 'emerald'
    ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
    : 'border-rose-200 bg-rose-50 text-rose-700';
  return (
    <div className={`rounded-lg border p-2 ${accentCls}`}>
      <label className="block text-[11px] font-bold mb-1">{label}</label>
      <select
        value={value || ''}
        onChange={e => onChange(e.target.value || null)}
        className="w-full bg-white border border-slate-200 rounded-md px-2 py-1.5 text-xs text-slate-700 focus:outline-none focus:ring-2 focus:ring-amber-400"
      >
        <option value="">— pick a task —</option>
        {tasks.map(t => (
          <option key={t.id || t._id} value={t.id || t._id}>{t.name}</option>
        ))}
      </select>
    </div>
  );
}

// Switch editor: a list of cases, each = a value + the task it routes to.
function SwitchCaseEditor({ cases, tasks, onChange }) {
  function addCase() { onChange([...cases, { value: '', target: null }]); }
  function update(i, patch) { onChange(cases.map((c, idx) => idx === i ? { ...c, ...patch } : c)); }
  function remove(i) { onChange(cases.filter((_, idx) => idx !== i)); }

  return (
    <div className="space-y-2">
      <label className="block text-xs font-medium text-slate-600">Cases — value → task</label>
      {cases.map((c, i) => (
        <div key={i} className="flex items-center gap-2">
          <input
            className="w-32 border border-slate-200 rounded-md px-2 py-1.5 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-amber-400"
            value={c.value}
            onChange={e => update(i, { value: e.target.value })}
            placeholder="e.g. travel"
          />
          <span className="text-slate-400 text-xs">→</span>
          <select
            value={c.target || ''}
            onChange={e => update(i, { target: e.target.value || null })}
            className="flex-1 bg-white border border-slate-200 rounded-md px-2 py-1.5 text-xs text-slate-700 focus:outline-none focus:ring-2 focus:ring-amber-400"
          >
            <option value="">— pick a task —</option>
            {tasks.map(t => (
              <option key={t.id || t._id} value={t.id || t._id}>{t.name}</option>
            ))}
          </select>
          <button type="button" onClick={() => remove(i)} className="text-slate-300 hover:text-red-400"><X size={14} /></button>
        </div>
      ))}
      <button type="button" onClick={addCase}
        className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-full border border-dashed border-amber-300 text-amber-600 hover:bg-amber-50">
        <Plus size={12} /> Add case
      </button>
    </div>
  );
}

// ── Step 3: Steps (Task / Conditional / Loop) ──────────
function StepsBuilder({ steps, onChange }) {
  const [expandedIdx, setExpandedIdx] = useState(null);
  const sets = getObjectSets();

  function addStep(type) {
    const base = {
      _id: Math.random().toString(36).slice(2),
      id: null,
      type,
      name: type === 'conditional' ? 'New Decision' : type === 'loop' ? 'New Loop' : 'New Task',
      description: '',
      PreReq: 'none',
      Tasksteps: [],
    };
    if (type === 'conditional') {
      base.condition = 'if/else';
      base.conditionExpr = '';
      base.branches = [];
    }
    if (type === 'loop') {
      base.loopSet = sets[0]?.id || 'MSA';
      base.loopExpr = '';
    }
    onChange([...steps, base]);
    setExpandedIdx(steps.length);
  }

  function update(idx, patch) {
    const updated = [...steps];
    updated[idx] = { ...updated[idx], ...patch };
    onChange(updated);
  }

  function remove(idx) {
    onChange(steps.filter((_, i) => i !== idx));
    if (expandedIdx === idx) setExpandedIdx(null);
  }

  // Switch: set the full case list ([{ value, target }]). Patches the
  // conditional's cases + branch labels, and wires each target task's PreReq
  // to depend on this conditional.
  function setSwitchCases(condIdx, cases) {
    const cond = steps[condIdx];
    const condId = stepKey(cond);
    const targetIds = new Set(cases.map(c => c.target).filter(Boolean));

    const nameOf = id => (steps.find(s => stepKey(s) === id) || {}).name || '';
    const branches = cases
      .filter(c => c.value || c.target)
      .map(c => `${c.value || 'case'} → ${nameOf(c.target)}`);

    const next = steps.map((s, i) => {
      if (i === condIdx) return { ...s, cases, branches };
      const sid = stepKey(s);
      const cur = Array.isArray(s.PreReq) ? s.PreReq : [];
      if (targetIds.has(sid)) {
        return cur.includes(condId) ? s : { ...s, PreReq: [...cur, condId] };
      }
      // no longer a target → strip condId
      if (cur.includes(condId)) {
        const stripped = cur.filter(x => x !== condId);
        return { ...s, PreReq: stripped.length ? stripped : 'none' };
      }
      return s;
    });
    onChange(next);
  }

  // Pick which task a conditional's TRUE/FALSE branch routes to. This patches
  // both the conditional (target ids + labels) AND wires the target task's
  // PreReq to depend on this conditional, so the flow chart routes correctly.
  function setBranchTarget(condIdx, side, targetId) {
    const cond = steps[condIdx];
    const condId = stepKey(cond);
    const prevId = side === 'true' ? cond.trueTarget : cond.falseTarget;

    const next = steps.map((s, i) => {
      if (i === condIdx) {
        const patched = syncBranches(
          { ...s, [side === 'true' ? 'trueTarget' : 'falseTarget']: targetId || null },
          steps
        );
        return patched;
      }
      const sid = stepKey(s);
      // newly selected target → add condId to its PreReq
      if (sid === targetId) {
        const cur = Array.isArray(s.PreReq) ? s.PreReq : [];
        return { ...s, PreReq: cur.includes(condId) ? cur : [...cur, condId] };
      }
      // previously selected target that's being replaced → remove condId
      if (sid === prevId && prevId !== targetId) {
        const cur = Array.isArray(s.PreReq) ? s.PreReq : [];
        const stripped = cur.filter(x => x !== condId);
        return { ...s, PreReq: stripped.length ? stripped : 'none' };
      }
      return s;
    });
    onChange(next);
  }

  return (
    <div className="space-y-3">
      {steps.length > 0 && (
        <div className="space-y-2">
          {steps.map((step, idx) => {
            const meta = typeMeta(step.type);
            return (
              <div key={step._id || step.id || idx} className="border border-slate-200 rounded-xl overflow-hidden bg-white">
                <div className="flex items-center gap-2 px-4 py-3">
                  <span className="w-6 h-6 rounded-full bg-slate-100 text-slate-500 text-xs font-bold flex items-center justify-center shrink-0">
                    {idx + 1}
                  </span>
                  <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${typeBadgeCls[step.type]}`}>
                    {meta.icon} {meta.label}
                  </span>
                  <input className="flex-1 text-sm font-medium text-slate-800 focus:outline-none bg-transparent"
                    value={step.name} onChange={e => update(idx, { name: e.target.value })} />
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
                        value={step.description} onChange={e => update(idx, { description: e.target.value })} />
                    </div>

                    {/* PreReq */}
                    {idx > 0 && (
                      <div>
                        <label className="block text-xs font-medium text-slate-600 mb-1">
                          Prerequisites <span className="font-normal text-slate-400">(none = runs in parallel)</span>
                        </label>
                        <div className="flex flex-wrap gap-1.5">
                          {/* Only Task/Loop steps can be prerequisites — a conditional
                              just routes, so depending on a diamond is hidden. */}
                          {steps.slice(0, idx).filter(t => t.type !== 'conditional').map((t, ti) => {
                            const tid = t.id || t._id;
                            const selected = Array.isArray(step.PreReq) && step.PreReq.includes(tid);
                            return (
                              <button type="button" key={ti}
                                onClick={() => {
                                  const current = Array.isArray(step.PreReq) ? step.PreReq : [];
                                  update(idx, { PreReq: selected ? current.filter(x => x !== tid) : [...current, tid] });
                                }}
                                className={`text-xs px-2.5 py-1 rounded-full border ${selected ? 'bg-violet-600 text-white border-violet-600' : 'border-slate-200 text-slate-500 hover:border-violet-300'}`}>
                                {t.name}
                              </button>
                            );
                          })}
                          <button type="button"
                            onClick={() => update(idx, { PreReq: 'none' })}
                            className={`text-xs px-2.5 py-1 rounded-full border ${(step.PreReq === 'none' || !Array.isArray(step.PreReq) || step.PreReq.length === 0) ? 'bg-slate-600 text-white border-slate-600' : 'border-slate-200 text-slate-400'}`}>
                            none (parallel)
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Conditional config */}
                    {step.type === 'conditional' && (
                      <div className="space-y-2">
                        <div>
                          <label className="block text-xs font-medium text-slate-600 mb-1">Condition kind ◆</label>
                          <div className="flex gap-1.5">
                            {CONDITION_KINDS.map(c => (
                              <button type="button" key={c} onClick={() => update(idx, { condition: c })}
                                className={`px-2.5 py-1 rounded-full text-xs border ${step.condition === c ? 'bg-amber-500 text-white border-amber-500' : 'border-slate-200 text-slate-500'}`}>
                                {c}
                              </button>
                            ))}
                          </div>
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-slate-600 mb-1">Expression</label>
                          <input className="w-full border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400 font-mono"
                            value={step.conditionExpr} onChange={e => update(idx, { conditionExpr: e.target.value })}
                            placeholder={step.condition === 'switch' ? 'e.g. category' : 'e.g. amount > 1000'} />
                        </div>

                        {/* if/else → pick which task each branch routes to */}
                        {step.condition === 'if/else' && (
                          <div className="grid grid-cols-2 gap-2">
                            <BranchTargetPicker
                              label="if TRUE → do task"
                              accent="emerald"
                              value={step.trueTarget}
                              tasks={branchTargetOptions(steps, idx)}
                              onChange={tid => setBranchTarget(idx, 'true', tid)}
                            />
                            <BranchTargetPicker
                              label="if FALSE → do task"
                              accent="rose"
                              value={step.falseTarget}
                              tasks={branchTargetOptions(steps, idx)}
                              onChange={tid => setBranchTarget(idx, 'false', tid)}
                            />
                          </div>
                        )}

                        {/* switch → per-case value + task picker */}
                        {step.condition === 'switch' && (
                          <SwitchCaseEditor
                            cases={step.cases || []}
                            tasks={branchTargetOptions(steps, idx)}
                            onChange={cs => setSwitchCases(idx, cs)}
                          />
                        )}
                      </div>
                    )}

                    {/* Loop config */}
                    {step.type === 'loop' && (
                      <div className="space-y-2">
                        <div>
                          <label className="block text-xs font-medium text-slate-600 mb-1">For each item in set ↻</label>
                          <div className="flex flex-wrap gap-1.5">
                            {sets.map(s => (
                              <button type="button" key={s.id} onClick={() => update(idx, { loopSet: s.id })}
                                className={`text-xs px-2.5 py-1 rounded-full border ${step.loopSet === s.id ? 'bg-purple-500 text-white border-purple-500' : 'border-slate-200 text-slate-500'}`}>
                                {s.name} <span className="opacity-60">({s.size})</span>
                              </button>
                            ))}
                          </div>
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-slate-600 mb-1">Loop description</label>
                          <input className="w-full border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-purple-400"
                            value={step.loopExpr} onChange={e => update(idx, { loopExpr: e.target.value })}
                            placeholder="e.g. for each episode until all reviewed" />
                        </div>
                      </div>
                    )}

                    {/* Sub-steps (for task & loop) */}
                    {step.type !== 'conditional' && (
                      <div>
                        <label className="block text-xs font-medium text-slate-600 mb-2">Sub-steps</label>
                        <SubStepEditor subSteps={step.Tasksteps || []} onChange={v => update(idx, { Tasksteps: v })} />
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Add step buttons — 3 types only */}
      <div className="flex flex-wrap gap-2">
        {STEP_TYPES.map(t => (
          <button type="button" key={t.id} onClick={() => addStep(t.id)}
            className="flex items-center gap-1.5 px-3 py-2 text-sm border-2 border-dashed border-slate-200 rounded-xl text-slate-500 hover:border-violet-300 hover:text-violet-600 transition-colors">
            <Plus size={14} /> <span className="font-medium">{t.icon} {t.label}</span>
            <span className="text-xs opacity-60">{t.desc}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Step 4: Review ─────────────────────────────────────
function StepReview({ data }) {
  const trigger = getTriggers().find(t => t.id === data.triggerId);
  return (
    <div className="space-y-4">
      <div className="bg-slate-50 rounded-xl p-4 space-y-2">
        <div className="flex justify-between text-sm">
          <span className="text-slate-500">Trigger</span>
          <span className="font-medium text-slate-800">{trigger ? `${trigger.name} — ${trigger.label}` : '—'}</span>
        </div>
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
      </div>

      <div>
        <h3 className="text-sm font-semibold text-slate-700 mb-2">Steps ({data.steps?.length || 0})</h3>
        {(data.steps || []).map((s, i) => {
          const meta = typeMeta(s.type);
          return (
            <div key={i} className="mb-2 bg-white border border-slate-100 rounded-lg p-3">
              <div className="flex items-center gap-2 flex-wrap mb-1">
                <span className="text-xs font-bold text-slate-400">{i + 1}</span>
                <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${typeBadgeCls[s.type]}`}>{meta.icon} {meta.label}</span>
                <span className="font-medium text-slate-800 text-sm">{s.name}</span>
                {s.type === 'conditional' && s.conditionExpr && (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 font-mono">{s.condition} · {s.conditionExpr}</span>
                )}
                {s.type === 'loop' && (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-purple-50 text-purple-700 font-mono">↻ {s.loopSet}</span>
                )}
                {Array.isArray(s.PreReq) && s.PreReq.length > 0 && (
                  <span className="text-xs text-slate-400">after {s.PreReq.length} step{s.PreReq.length > 1 ? 's' : ''}</span>
                )}
              </div>
              {s.type === 'conditional'
                ? (s.branches || []).map((b, bi) => (
                    <div key={bi} className="ml-4 flex items-center gap-2 text-xs text-amber-600 mt-0.5 font-mono">
                      <span className="w-1 h-1 rounded-full bg-amber-300" /> {b}
                    </div>
                  ))
                : (s.Tasksteps || []).map((step, si) => (
                    <div key={si} className="ml-4 flex items-center gap-2 text-xs text-slate-600 mt-0.5">
                      <span className="w-1 h-1 rounded-full bg-slate-300" /> {step}
                    </div>
                  ))
              }
            </div>
          );
        })}
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

  const [workflows] = useState(() => {
    // snapshot of mapped triggers for highlighting
    try { return JSON.parse(localStorage.getItem('wf_workflows')) || []; } catch { return []; }
  });

  const [step, setStep] = useState(isEditing ? 1 : 0);

  function normalize(wf) {
    const steps = (wf.steps || wf.tasks || []).map(s => ({ ...s, _id: s._id || Math.random().toString(36).slice(2) }));
    return { ...wf, steps };
  }

  const presetTriggerId = location.state?.presetTriggerId || null;

  const [wf, setWf] = useState(() => {
    if (existing) return normalize(existing);
    if (presetTriggerId) {
      const trig = getTriggers().find(t => t.id === presetTriggerId);
      return { triggerId: presetTriggerId, name: trig?.label || '', description: trig?.description || '', steps: [] };
    }
    return { triggerId: null, name: '', description: '', steps: [] };
  });

  // When a trigger with an existing workflow is picked (and we're not editing),
  // load its predefined tasks so the user starts from the template.
  function pickTrigger(next) {
    if (next.triggerId && next.triggerId !== wf.triggerId && !isEditing) {
      const tmpl = getWorkflowForTrigger(next.triggerId);
      if (tmpl) {
        setWf(normalize({ ...tmpl, triggerId: next.triggerId }));
        return;
      }
      // unmapped trigger → prefill name from trigger label
      const trig = getTriggers().find(t => t.id === next.triggerId);
      setWf({ triggerId: next.triggerId, name: trig?.label || '', description: trig?.description || '', steps: [] });
      return;
    }
    setWf(next);
  }

  function canNext() {
    if (step === 0) return !!wf.triggerId;
    if (step === 1) return !!wf.name.trim();
    return true;
  }

  function handleSave() {
    const rawSteps = wf.steps || [];

    // Give every step a stable real id (reuse existing id, else promote its
    // builder _id). Build a map from whatever key was used in references
    // (id OR _id) → the final stable id, so PreReq / branch targets survive.
    const keyToId = {};
    const withIds = rawSteps.map(s => {
      const finalId = s.id || s._id || Math.random().toString(36).slice(2);
      if (s.id) keyToId[s.id] = finalId;
      if (s._id) keyToId[s._id] = finalId;
      return { ...s, id: finalId };
    });

    const remap = ref => keyToId[ref] || ref;

    const cleanSteps = withIds.map(({ _id, ...s }) => {
      const out = { ...s };
      if (Array.isArray(s.PreReq)) {
        const mapped = s.PreReq.map(remap);
        out.PreReq = mapped.length ? mapped : 'none';
      }
      if (s.trueTarget)  out.trueTarget  = remap(s.trueTarget);
      if (s.falseTarget) out.falseTarget = remap(s.falseTarget);
      if (Array.isArray(s.cases)) {
        out.cases = s.cases.map(c => ({ ...c, target: c.target ? remap(c.target) : null }));
      }
      return out;
    });

    saveWorkflow({ ...wf, steps: cleanSteps });
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
        {step === 0 && <StepTrigger data={wf} onChange={pickTrigger} workflows={workflows} />}
        {step === 1 && <StepIdentity data={wf} onChange={setWf} />}
        {step === 2 && <StepsBuilder steps={wf.steps} onChange={steps => setWf(w => ({ ...w, steps }))} />}
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
