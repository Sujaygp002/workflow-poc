import { CheckCircle2, Circle, Lock } from 'lucide-react';

// Shared flow-chart renderer used by both the Workflows page (static definition)
// and the Orchestrator (live instance). It accepts a normalized list of "nodes".
//
// Node shape:
//   { id, name, type: 'task'|'conditional'|'loop',
//     condition, conditionExpr, branches, loopSet, loopExpr,
//     subSteps: [{ name, status?, assignee? }],   // status/assignee only when live
//     status? }                                    // 'pending'|'active'|'completed' when live

const typeBadgeCls = {
  task:        'bg-violet-100 text-violet-700',
  conditional: 'bg-amber-100 text-amber-700',
  loop:        'bg-purple-100 text-purple-700',
};
const typeIcon = { task: '▸', conditional: '◆', loop: '↻' };

const gateCls = {
  conditional: 'bg-amber-50 border-amber-300 text-amber-700',
  loop:        'bg-purple-50 border-purple-300 text-purple-700',
};

function subStepIcon(status) {
  if (status === 'completed') return <CheckCircle2 size={12} className="text-green-500 shrink-0" />;
  if (status === 'active')    return <Circle size={12} className="text-amber-400 fill-amber-100 shrink-0" />;
  if (status === 'blocked')   return <Lock size={11} className="text-slate-300 shrink-0" />;
  return <span className="w-1.5 h-1.5 rounded-full bg-slate-300 shrink-0" />;
}

function Connector() {
  return (
    <div className="flex flex-col items-center select-none">
      <div className="w-px h-4 bg-slate-300" />
      <svg width="10" height="6" viewBox="0 0 10 6" className="text-slate-300">
        <path d="M0 0 L5 6 L10 0" fill="currentColor" />
      </svg>
    </div>
  );
}

// The diamond / loop gate that sits between steps.
function Gate({ node }) {
  if (node.type !== 'conditional' && node.type !== 'loop') {
    return <Connector />;
  }
  const cls = gateCls[node.type];
  return (
    <div className="flex flex-col items-center select-none">
      <div className="w-px h-4 bg-slate-300" />
      <div className={`border-2 rounded-lg px-3 py-1 text-xs font-semibold flex items-center gap-1.5 ${cls}`}>
        <span className="text-base leading-none">{typeIcon[node.type]}</span>
        {node.type === 'conditional' ? (
          <>
            <span className="capitalize">{node.condition || 'if/else'}</span>
            {node.conditionExpr && <span className="font-mono opacity-70">{node.conditionExpr}</span>}
          </>
        ) : (
          <>
            <span>for each in {node.loopSet}</span>
            {node.loopExpr && <span className="font-mono opacity-70">· {node.loopExpr}</span>}
          </>
        )}
      </div>
      {node.type === 'conditional' && (node.branches || []).length > 0 && (
        <div className="flex flex-wrap justify-center gap-1.5 mt-1.5 max-w-[300px]">
          {node.branches.map((b, i) => (
            <span key={i} className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${cls} opacity-90`}>{b}</span>
          ))}
        </div>
      )}
      <div className="w-px h-4 bg-slate-300" />
      <svg width="10" height="6" viewBox="0 0 10 6" className="text-slate-300">
        <path d="M0 0 L5 6 L10 0" fill="currentColor" />
      </svg>
    </div>
  );
}

function StepNode({ node }) {
  const live = !!node.status;
  const done = (node.subSteps || []).filter(s => s.status === 'completed').length;
  const total = (node.subSteps || []).length;

  const borderCls = !live
    ? 'border-slate-200 bg-white'
    : node.status === 'completed'
      ? 'border-green-300 bg-green-50/40'
      : node.status === 'active'
        ? 'border-violet-300 bg-violet-50/40 ring-2 ring-violet-100'
        : 'border-slate-200 bg-white opacity-70';

  return (
    <div className={`border-2 rounded-2xl shadow-sm overflow-hidden w-[230px] ${borderCls}`}>
      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-100 bg-white/70">
        <span className={`text-xs px-1.5 py-0.5 rounded font-semibold shrink-0 ${typeBadgeCls[node.type]}`}>
          {typeIcon[node.type]}
        </span>
        <span className="font-semibold text-slate-800 text-sm flex-1 truncate">{node.name}</span>
        {live && <span className="text-xs text-slate-400 shrink-0">{done}/{total}</span>}
      </div>
      <div className="p-2 flex flex-col gap-1">
        {(node.subSteps || []).map((s, i) => (
          <div key={i} className="flex items-center gap-2 text-xs px-1 py-0.5">
            {live ? subStepIcon(s.status) : <span className="w-1.5 h-1.5 rounded-full bg-slate-300 shrink-0" />}
            <span className={`flex-1 truncate ${s.status === 'completed' ? 'line-through text-slate-400' : s.status === 'blocked' ? 'text-slate-400' : 'text-slate-700'}`}>
              {s.name}
            </span>
            {s.assignee && (
              <span className="w-4 h-4 rounded-full bg-violet-200 text-violet-700 text-[9px] font-bold flex items-center justify-center shrink-0" title={s.assignee}>
                {s.assignee[0]}
              </span>
            )}
          </div>
        ))}
        {(!node.subSteps || node.subSteps.length === 0) && (
          <div className="text-xs text-slate-300 italic px-1">decision only</div>
        )}
      </div>
    </div>
  );
}

function Terminal({ label, done }) {
  return (
    <div className={`rounded-full px-6 py-1.5 text-sm font-bold border-2 ${done ? 'border-green-400 bg-green-50 text-green-700' : 'border-violet-400 bg-violet-50 text-violet-700'}`}>
      {label}
    </div>
  );
}

export default function WorkflowFlowChart({ nodes, endDone = false }) {
  if (!nodes || nodes.length === 0) {
    return <div className="text-center py-6 text-slate-400 text-sm">No steps to display.</div>;
  }
  return (
    <div className="flex flex-col items-center py-6 px-4 overflow-x-auto">
      <Terminal label="START" done={false} />
      {nodes.map((node, i) => (
        <div key={node.id || i} className="flex flex-col items-center">
          <Gate node={node} />
          <StepNode node={node} />
        </div>
      ))}
      <Connector />
      <Terminal label="END" done={endDone} />
    </div>
  );
}

// ── Adapters ───────────────────────────────────────────

// From a stored workflow definition (workflow.steps).
export function nodesFromWorkflow(wf) {
  const steps = wf.steps || wf.tasks || [];
  return steps.map(s => ({
    id: s.id,
    name: s.name,
    type: s.type || 'task',
    condition: s.condition,
    conditionExpr: s.conditionExpr,
    branches: s.branches || [],
    loopSet: s.loopSet,
    loopExpr: s.loopExpr,
    subSteps: (s.type === 'conditional' ? [] : (s.Tasksteps || [])).map(name => ({ name })),
  }));
}

// From a live launched instance (instance.taskInstances), with status + people.
export function nodesFromInstance(instance, users = []) {
  return (instance.taskInstances || []).map(ti => ({
    id: ti.id,
    name: ti.taskName,
    type: ti.type || 'task',
    condition: ti.condition,
    conditionExpr: ti.conditionExpr,
    branches: ti.branches || [],
    loopSet: ti.loopSet,
    loopExpr: ti.loopExpr,
    status: ti.status,
    subSteps: (ti.actionInstances || []).map(ai => ({
      name: ai.actionName,
      status: ai.status,
      assignee: (users.find(u => u.id === ai.assignedTo) || {}).name || null,
    })),
  }));
}
