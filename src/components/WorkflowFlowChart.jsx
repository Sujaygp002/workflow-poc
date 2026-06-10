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
//     assignee?,   // present when live (the one person on the task)
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

// ── Task / loop box — atomic unit (no sub-steps) ───────
function StepBox({ node }) {
  const live = !!node.status;
  const skipped = node.status === 'skipped';
  // actor coloring: system = sky/blue, human = pink. Falls back to default.
  const actorTint = node.actor === 'human'
    ? 'border-pink-300 bg-pink-50/50'
    : node.actor === 'system'
      ? 'border-sky-300 bg-sky-50/50'
      : 'border-slate-200 bg-white';
  const borderCls = !live
    ? actorTint
    : skipped
      ? 'border-dashed border-slate-200 bg-slate-50 opacity-50'
      : node.status === 'completed'
        ? 'border-green-300 bg-green-50/40'
        : node.status === 'active'
          ? (node.actor === 'human' ? 'border-pink-400 bg-pink-50/50 ring-2 ring-pink-100' : 'border-violet-300 bg-violet-50/40 ring-2 ring-violet-100')
          : 'border-slate-200 bg-white opacity-70';

  return (
    <div className={`border-2 rounded-2xl shadow-sm overflow-hidden w-[220px] ${borderCls}`}>
      <div className="flex items-center gap-2 px-3 py-2.5">
        <span className={`text-xs px-1.5 py-0.5 rounded font-semibold shrink-0 ${typeBadgeCls[node.type]}`}>
          {typeIcon[node.type]}
        </span>
        <span className={`font-semibold text-sm flex-1 truncate ${skipped ? 'text-slate-400 line-through' : 'text-slate-800'}`}>{node.name}</span>
        {node.actor && !live && (
          <span className={`text-[9px] px-1 py-0.5 rounded font-bold shrink-0 ${node.actor === 'human' ? 'bg-pink-100 text-pink-600' : 'bg-sky-100 text-sky-600'}`}>
            {node.actor === 'human' ? 'HUMAN' : 'SYS'}
          </span>
        )}
        {live && (skipped
          ? <span className="text-[10px] text-slate-400 shrink-0 italic">skipped</span>
          : subStepIcon(node.status))}
      </div>
      {node.type === 'loop' && (
        <div className="px-3 py-1 bg-purple-50/60 border-t border-purple-100 text-[10px] font-mono text-purple-700">
          ↻ for each in {node.loopSet}{node.loopExpr ? ` · ${node.loopExpr}` : ''}
        </div>
      )}
      {node.when && (
        <div className="px-3 py-1 bg-amber-50/60 border-t border-amber-100 text-[10px] font-mono text-amber-700">
          ◆ when {node.when.expr} = {String(node.when.equals).toUpperCase()}
        </div>
      )}
      {live && !skipped && node.assignee && (
        <div className="px-3 py-1.5 border-t border-slate-100 flex items-center gap-1.5 bg-white/60">
          <span className="w-4 h-4 rounded-full bg-violet-200 text-violet-700 text-[9px] font-bold flex items-center justify-center shrink-0">
            {node.assignee[0]}
          </span>
          <span className="text-[11px] text-slate-500">{node.assignee}</span>
        </div>
      )}
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

// A conditional drawn as a diamond that forks to N branch-target boxes.
// `branches` is an array of { label, child }. Each column shows the case label
// on the connector and the task box below, with an arrowhead touching it.
function ConditionalBranch({ node, branches }) {
  // Only branches that actually point to a task are drawn.
  const real = branches.filter(b => b.child);

  // No resolved target → just the diamond (caller adds the trailing arrow).
  if (real.length === 0) {
    return <Diamond node={node} />;
  }

  // Exactly one target → straight-down arrow, no fork, no empty side.
  if (real.length === 1) {
    const b = real[0];
    return (
      <div className="flex flex-col items-center">
        <Diamond node={node} />
        <svg width="20" height="34" viewBox="0 0 20 34" className="text-slate-300 -mt-1">
          <path d="M10 0 L10 28" stroke="currentColor" strokeWidth="1.5" fill="none" />
          <path d="M6 24 L10 31 L14 24 Z" fill="currentColor" />
        </svg>
        {b.label && (
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-100 -mt-1 mb-1">
            {b.label}
          </span>
        )}
        <StepBox node={b.child} />
      </div>
    );
  }

  const COL = 230;            // column width (box 220 + breathing room)
  const cols = real.length;
  const width = cols * COL;
  const center = width / 2;
  const colCenter = i => i * COL + COL / 2;

  return (
    <div className="flex flex-col items-center">
      <Diamond node={node} />

      {/* fork connector: diamond → bar → drop into each box */}
      <svg width={width} height="40" viewBox={`0 0 ${width} 40`} className="text-slate-300 -mt-1">
        <path d={`M${center} 0 L${center} 10`} stroke="currentColor" strokeWidth="1.5" fill="none" />
        <path d={`M${colCenter(0)} 10 L${colCenter(cols - 1)} 10`} stroke="currentColor" strokeWidth="1.5" fill="none" />
        {real.map((_, i) => {
          const x = colCenter(i);
          return (
            <g key={i}>
              <path d={`M${x} 10 L${x} 34`} stroke="currentColor" strokeWidth="1.5" fill="none" />
              <path d={`M${x - 4} 30 L${x} 37 L${x + 4} 30 Z`} fill="currentColor" />
            </g>
          );
        })}
      </svg>

      {/* case labels row */}
      <div className="flex -mt-1" style={{ width }}>
        {real.map((b, i) => (
          <div key={i} className="flex justify-center" style={{ width: COL }}>
            {b.label && (
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-100">
                {b.label}
              </span>
            )}
          </div>
        ))}
      </div>

      {/* target boxes */}
      <div className="flex mt-1" style={{ width }}>
        {real.map((b, i) => (
          <div key={i} className="flex justify-center" style={{ width: COL }}>
            <StepBox node={b.child} />
          </div>
        ))}
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

// Resolve a conditional into an ordered list of branches: [{ label, child }].
//  - switch: one branch per case ({ value, target }), in order.
//  - if/else: FALSE (left) then TRUE (right), from explicit targets, with a
//    PreReq/label fallback for older data.
function branchChildren(node, nodes) {
  const byId = {};
  nodes.forEach(n => { byId[n.id] = n; });

  // ── switch ──
  if (node.condition === 'switch') {
    const cases = node.cases || [];
    if (cases.length) {
      const branches = cases.map(c => ({
        label: c.value || 'case',
        child: c.target ? byId[c.target] || null : null,
      }));
      return { branches, childIds: branches.map(b => b.child?.id).filter(Boolean) };
    }
    // fallback: children by PreReq, labels from branch strings
    const children = nodes.filter(n => Array.isArray(n.PreReq) && n.PreReq.includes(node.id));
    const branches = children.map((c, i) => ({ label: (node.branches || [])[i] || '', child: c }));
    return { branches, childIds: children.map(c => c.id) };
  }

  // ── if/else ──
  let trueChild  = node.trueTarget  ? byId[node.trueTarget]  : null;
  let falseChild = node.falseTarget ? byId[node.falseTarget] : null;
  if (!trueChild || !falseChild) {
    const children = nodes.filter(n => Array.isArray(n.PreReq) && n.PreReq.includes(node.id));
    const labels = node.branches || [];
    const findByLabel = (kw) => {
      const label = labels.find(b => b.toLowerCase().startsWith(kw));
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
  const branches = [
    { label: 'false', child: falseChild },
    { label: 'true',  child: trueChild },
  ];
  return { branches, childIds: [falseChild?.id, trueChild?.id].filter(Boolean) };
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
                const { branches } = branchChildren(node, nodes);
                return (
                  <ConditionalBranch key={node.id} node={node} branches={branches} />
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
    actor: s.actor || null,
    when: s.when || null,
    condition: s.condition,
    conditionExpr: s.conditionExpr,
    branches: s.branches || [],
    trueTarget: s.trueTarget || null,
    falseTarget: s.falseTarget || null,
    cases: s.cases || [],
    loopSet: s.loopSet,
    loopExpr: s.loopExpr,
    PreReq: s.PreReq || 'none',
  }));
}

export function nodesFromInstance(instance, users = [], taskInstancesOverride = null) {
  const tis = taskInstancesOverride || instance.taskInstances || [];
  // Map the definition stepId → this run's generated node id, so PreReq
  // (which references stepIds) resolves to instance node ids for layout.
  const stepIdToNodeId = {};
  tis.forEach(ti => { if (ti.stepId) stepIdToNodeId[ti.stepId] = ti.id; });

  return tis.map(ti => ({
    id: ti.id,
    name: ti.taskName,
    type: ti.type || 'task',
    actor: ti.actor || null,
    condition: ti.condition,
    conditionExpr: ti.conditionExpr,
    branches: ti.branches || [],
    trueTarget: ti.trueTarget ? stepIdToNodeId[ti.trueTarget] : null,
    falseTarget: ti.falseTarget ? stepIdToNodeId[ti.falseTarget] : null,
    cases: (ti.cases || []).map(c => ({ value: c.value, target: c.target ? stepIdToNodeId[c.target] : null })),
    loopSet: ti.loopSet,
    loopExpr: ti.loopExpr,
    PreReq: Array.isArray(ti.PreReq)
      ? ti.PreReq.map(sid => stepIdToNodeId[sid]).filter(Boolean)
      : 'none',
    status: ti.status,
    assignee: (users.find(u => u.id === (ti.assignedTo || (ti.actionInstances || [])[0]?.assignedTo)) || {}).name || null,
  }));
}
