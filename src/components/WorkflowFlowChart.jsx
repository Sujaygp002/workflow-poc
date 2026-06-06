import { CheckCircle2, Circle, Lock } from 'lucide-react';

// Shared flow-chart renderer used by both the Workflows page (static definition)
// and the Orchestrator (live instance).
//
// Layout rules:
//   - Steps are grouped into "rows" by prerequisite depth.
//     A step with NO prerequisite sits in row 0; steps sharing a row run in
//     PARALLEL (side-by-side). A step WITH prerequisites sits one row below its
//     deepest prereq → SEQUENTIAL (arrow down from the prereq).
//   - A 'conditional' step is drawn as a diamond that branches:
//        false → left,  true → right.
//
// Node shape:
//   { id, name, type: 'task'|'conditional'|'loop',
//     condition, conditionExpr, branches: [..],
//     loopSet, loopExpr, PreReq: 'none' | [ids],
//     subSteps: [{ name, status?, assignee? }],
//     status? }   // present when live

const typeBadgeCls = {
  task:        'bg-violet-100 text-violet-700',
  conditional: 'bg-amber-100 text-amber-700',
  loop:        'bg-purple-100 text-purple-700',
};
const typeIcon = { task: '▸', conditional: '◆', loop: '↻' };

function subStepIcon(status) {
  if (status === 'completed') return <CheckCircle2 size={12} className="text-green-500 shrink-0" />;
  if (status === 'active')    return <Circle size={12} className="text-amber-400 fill-amber-100 shrink-0" />;
  if (status === 'blocked')   return <Lock size={11} className="text-slate-300 shrink-0" />;
  return <span className="w-1.5 h-1.5 rounded-full bg-slate-300 shrink-0" />;
}

function ArrowDownTiny() {
  return (
    <div className="flex flex-col items-center select-none">
      <div className="w-px h-4 bg-slate-300" />
      <svg width="10" height="6" viewBox="0 0 10 6" className="text-slate-300">
        <path d="M0 0 L5 6 L10 0" fill="currentColor" />
      </svg>
    </div>
  );
}

// ── Plain task / loop box ──────────────────────────────
function StepBox({ node }) {
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
    <div className={`border-2 rounded-2xl shadow-sm overflow-hidden w-[220px] ${borderCls}`}>
      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-100 bg-white/70">
        <span className={`text-xs px-1.5 py-0.5 rounded font-semibold shrink-0 ${typeBadgeCls[node.type]}`}>
          {typeIcon[node.type]}
        </span>
        <span className="font-semibold text-slate-800 text-sm flex-1 truncate">{node.name}</span>
        {live && <span className="text-xs text-slate-400 shrink-0">{done}/{total}</span>}
      </div>
      {node.type === 'loop' && (
        <div className="px-3 py-1 bg-purple-50/60 border-b border-purple-100 text-[10px] font-mono text-purple-700">
          ↻ for each in {node.loopSet}{node.loopExpr ? ` · ${node.loopExpr}` : ''}
        </div>
      )}
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
          <div className="text-xs text-slate-300 italic px-1">no sub-steps</div>
        )}
      </div>
    </div>
  );
}

// ── Diamond only (the decision shape) ──────────────────
function Diamond({ node }) {
  const live = !!node.status;
  const diamondCls = !live
    ? 'border-amber-300 bg-amber-50 text-amber-700'
    : node.status === 'completed'
      ? 'border-green-400 bg-green-50 text-green-700'
      : node.status === 'active'
        ? 'border-amber-400 bg-amber-50 text-amber-800 ring-2 ring-amber-100'
        : 'border-slate-300 bg-white text-slate-500 opacity-70';
  return (
    <div className="relative w-40 h-40 flex items-center justify-center">
      <div className={`absolute w-28 h-28 rotate-45 border-2 rounded-lg ${diamondCls}`} />
      <div className="relative z-10 text-center px-2 max-w-[130px]">
        <div className="text-lg leading-none">◆</div>
        <div className="font-semibold text-xs mt-1 leading-tight">{node.name}</div>
        {node.conditionExpr && (
          <div className="font-mono text-[10px] opacity-70 mt-0.5 break-words">{node.conditionExpr}</div>
        )}
      </div>
    </div>
  );
}

// A conditional with its two branch-target boxes laid out left (false) /
// right (true), connected by plain labeled arrows directly to the tasks.
function ConditionalBranch({ node, falseChild, trueChild }) {
  return (
    <div className="flex flex-col items-center">
      <Diamond node={node} />
      {/* Connector: bar from the diamond fanning out, with vertical drops whose
          arrowheads land on each box. Columns are 220px wide + 40px gap, so the
          column centres are at x=110 and x=370 in a 480-wide canvas. */}
      <svg width="480" height="34" viewBox="0 0 480 34" className="text-slate-300 -mt-1">
        {/* down from diamond centre to the bar */}
        <path d="M240 0 L240 10" stroke="currentColor" strokeWidth="1.5" fill="none" />
        {/* horizontal bar spanning both column centres */}
        <path d="M110 10 L370 10" stroke="currentColor" strokeWidth="1.5" fill="none" />
        {/* left drop + arrowhead (touches false box) */}
        <path d="M110 10 L110 30" stroke="currentColor" strokeWidth="1.5" fill="none" />
        <path d="M106 26 L110 33 L114 26 Z" fill="currentColor" />
        {/* right drop + arrowhead (touches true box) */}
        <path d="M370 10 L370 30" stroke="currentColor" strokeWidth="1.5" fill="none" />
        <path d="M366 26 L370 33 L374 26 Z" fill="currentColor" />
      </svg>

      {/* the two branch boxes; arrowheads above land on them. -mt removes the gap. */}
      <div className="grid grid-cols-2 gap-10 -mt-2">
        <div className="flex justify-center">
          {falseChild ? <StepBox node={falseChild} /> : <span className="text-xs text-slate-300 italic">—</span>}
        </div>
        <div className="flex justify-center">
          {trueChild ? <StepBox node={trueChild} /> : <span className="text-xs text-slate-300 italic">—</span>}
        </div>
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

// ── Layered layout by prerequisite depth ───────────────
function buildRows(nodes) {
  const byId = {};
  nodes.forEach(n => { byId[n.id] = n; });

  const depth = {};
  function depthOf(n, seen = new Set()) {
    if (depth[n.id] != null) return depth[n.id];
    if (seen.has(n.id)) return 0;
    seen.add(n.id);
    const prereqs = Array.isArray(n.PreReq) ? n.PreReq.filter(id => byId[id]) : [];
    if (prereqs.length === 0) { depth[n.id] = 0; return 0; }
    const d = 1 + Math.max(...prereqs.map(id => depthOf(byId[id], seen)));
    depth[n.id] = d;
    return d;
  }
  nodes.forEach(n => depthOf(n));

  const rowsMap = {};
  nodes.forEach(n => {
    const d = depth[n.id];
    (rowsMap[d] = rowsMap[d] || []).push(n);
  });
  return Object.keys(rowsMap).sort((a, b) => a - b).map(k => rowsMap[k]);
}

// Resolve a conditional's TRUE/FALSE branch task boxes.
// Primary source of truth: the explicit trueTarget / falseTarget ids the user
// picked in the builder. Falls back to PreReq + branch-label matching for
// older data that has no explicit targets.
function branchChildren(node, nodes) {
  const byId = {};
  nodes.forEach(n => { byId[n.id] = n; });

  // 1) explicit targets (preferred)
  let trueChild  = node.trueTarget  ? byId[node.trueTarget]  : null;
  let falseChild = node.falseTarget ? byId[node.falseTarget] : null;

  // 2) fallback: children whose PreReq points at this conditional
  if (!trueChild || !falseChild) {
    const children = nodes.filter(n =>
      Array.isArray(n.PreReq) && n.PreReq.includes(node.id)
    );
    const branches = node.branches || [];
    const findByLabel = (kw) => {
      const label = branches.find(b => b.toLowerCase().startsWith(kw));
      if (!label) return null;
      return children.find(c => label.toLowerCase().includes(c.name.toLowerCase())) || null;
    };
    if (!falseChild) falseChild = findByLabel('false');
    if (!trueChild)  trueChild  = findByLabel('true');
    const used = new Set([falseChild?.id, trueChild?.id].filter(Boolean));
    const rest = children.filter(c => !used.has(c.id));
    if (!falseChild) falseChild = rest.shift() || null;
    if (!trueChild)  trueChild  = rest.shift() || null;
  }

  const childIds = [falseChild?.id, trueChild?.id].filter(Boolean);
  return { falseChild, trueChild, childIds };
}

export default function WorkflowFlowChart({ nodes, endDone = false }) {
  if (!nodes || nodes.length === 0) {
    return <div className="text-center py-6 text-slate-400 text-sm">No steps to display.</div>;
  }

  const rows = buildRows(nodes);

  // Children that are rendered inside a conditional's branch are removed from
  // their own row so they don't appear twice.
  const consumed = new Set();
  nodes.forEach(n => {
    if (n.type === 'conditional') {
      branchChildren(n, nodes).childIds.forEach(id => consumed.add(id));
    }
  });

  return (
    <div className="flex flex-col items-center py-6 px-4 overflow-x-auto">
      <Terminal label="START" done={false} />
      {rows.map((row, ri) => {
        const visible = row.filter(n => !consumed.has(n.id));
        if (visible.length === 0) return null;
        return (
        <div key={ri} className="flex flex-col items-center">
          <ArrowDownTiny />
          {/* parallel lane note when >1 in a row */}
          {visible.length > 1 && (
            <div className="text-[10px] font-medium text-slate-400 mb-1 flex items-center gap-1">
              ⫶ {visible.length} parallel · no prerequisite
            </div>
          )}
          <div className="flex items-start justify-center gap-6 flex-wrap">
            {visible.map(node => {
              if (node.type === 'conditional') {
                const { falseChild, trueChild } = branchChildren(node, nodes);
                return (
                  <ConditionalBranch key={node.id} node={node} falseChild={falseChild} trueChild={trueChild} />
                );
              }
              return (
                <div key={node.id} className="flex flex-col items-center">
                  <StepBox node={node} />
                </div>
              );
            })}
          </div>
        </div>
        );
      })}
      <ArrowDownTiny />
      <Terminal label="END" done={endDone} />
    </div>
  );
}

// ── Adapters ───────────────────────────────────────────

export function nodesFromWorkflow(wf) {
  const steps = wf.steps || wf.tasks || [];
  return steps.map(s => ({
    id: s.id,
    name: s.name,
    type: s.type || 'task',
    condition: s.condition,
    conditionExpr: s.conditionExpr,
    branches: s.branches || [],
    trueTarget: s.trueTarget || null,
    falseTarget: s.falseTarget || null,
    loopSet: s.loopSet,
    loopExpr: s.loopExpr,
    PreReq: s.PreReq || 'none',
    subSteps: (s.type === 'conditional' ? [] : (s.Tasksteps || [])).map(name => ({ name })),
  }));
}

export function nodesFromInstance(instance, users = []) {
  const tis = instance.taskInstances || [];
  // Map the definition stepId → this run's generated node id, so PreReq
  // (which references stepIds) resolves to instance node ids for layout.
  const stepIdToNodeId = {};
  tis.forEach(ti => { if (ti.stepId) stepIdToNodeId[ti.stepId] = ti.id; });

  return tis.map(ti => ({
    id: ti.id,
    name: ti.taskName,
    type: ti.type || 'task',
    condition: ti.condition,
    conditionExpr: ti.conditionExpr,
    branches: ti.branches || [],
    trueTarget: ti.trueTarget ? stepIdToNodeId[ti.trueTarget] : null,
    falseTarget: ti.falseTarget ? stepIdToNodeId[ti.falseTarget] : null,
    loopSet: ti.loopSet,
    loopExpr: ti.loopExpr,
    PreReq: Array.isArray(ti.PreReq)
      ? ti.PreReq.map(sid => stepIdToNodeId[sid]).filter(Boolean)
      : 'none',
    status: ti.status,
    subSteps: (ti.actionInstances || []).map(ai => ({
      name: ai.actionName,
      status: ai.status,
      assignee: (users.find(u => u.id === ai.assignedTo) || {}).name || null,
    })),
  }));
}
