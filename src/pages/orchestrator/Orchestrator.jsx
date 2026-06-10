import { useState, useEffect } from 'react';
import { Activity, ChevronDown, ChevronUp, CheckCircle2, Clock, Circle, AlertCircle, RefreshCw, Lock, ArrowDown, GitBranch, User, Cpu, Users as UsersIcon } from 'lucide-react';
import Badge from '../../components/Badge';
import WorkflowFlowChart, { nodesFromInstance } from '../../components/WorkflowFlowChart';
import RecordView from '../../components/RecordView';
import { getInstances, getUsers, instanceStage, completeActionInstance } from '../../store';

// Instance lifecycle header: unassigned → assigned → done
function StageHeader({ stage }) {
  const stages = ['unassigned', 'assigned', 'done'];
  const activeIdx = stages.indexOf(stage);
  return (
    <div className="flex items-center gap-1.5 mt-2">
      {stages.map((s, i) => {
        const reached = i <= activeIdx;
        const isCurrent = i === activeIdx;
        return (
          <div key={s} className="flex items-center gap-1.5">
            <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full border transition-colors ${
              isCurrent
                ? (s === 'done' ? 'bg-green-100 text-green-700 border-green-200' : 'bg-violet-100 text-violet-700 border-violet-200')
                : reached ? 'bg-slate-100 text-slate-500 border-slate-200' : 'bg-white text-slate-300 border-slate-100'
            }`}>
              {s}
            </span>
            {i < stages.length - 1 && (
              <span className={`text-xs ${i < activeIdx ? 'text-violet-400' : 'text-slate-300'}`}>→</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function statusIcon(status) {
  if (status === 'completed') return <CheckCircle2 size={14} className="text-green-500" />;
  if (status === 'active') return <Circle size={14} className="text-amber-400 fill-amber-100" />;
  if (status === 'blocked') return <Lock size={12} className="text-slate-300" />;
  if (status === 'running' || status === 'pending') return <Circle size={14} className="text-amber-400" />;
  return <AlertCircle size={14} className="text-red-400" />;
}

function progressBar(done, total) {
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
        <div className="h-full bg-violet-500 rounded-full transition-all" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-slate-400 w-8 text-right">{pct}%</span>
    </div>
  );
}

const typeBadgeCls = {
  task:        'bg-violet-100 text-violet-700',
  conditional: 'bg-amber-100 text-amber-700',
  loop:        'bg-purple-100 text-purple-700',
};
const typeIcon = { task: '▸', conditional: '◆', loop: '↻' };

// ── Gate between steps (conditional branches / loop set) ──
function StepGate({ ti }) {
  if (ti.type === 'conditional') {
    return (
      <div className="flex items-start gap-2 px-5 py-1.5">
        <div className="w-px h-4 bg-slate-200 mx-2 mt-1" />
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2 px-3 py-1 rounded-full border text-xs font-semibold bg-amber-50 border-amber-200 text-amber-700 w-fit">
            <span>◆</span><span className="capitalize">{ti.condition}</span>
            {ti.conditionExpr && <span className="opacity-70 font-mono">{ti.conditionExpr}</span>}
          </div>
          {(ti.branches || []).length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {ti.branches.map((b, i) => (
                <span key={i} className="text-[10px] font-mono px-1.5 py-0.5 rounded border bg-amber-50 border-amber-200 text-amber-700">{b}</span>
              ))}
            </div>
          )}
        </div>
        <ArrowDown size={10} className="text-slate-300 mt-1" />
      </div>
    );
  }
  if (ti.type === 'loop') {
    return (
      <div className="flex items-start gap-2 px-5 py-1.5">
        <div className="w-px h-4 bg-slate-200 mx-2 mt-1" />
        <div className="flex items-center gap-2 px-3 py-1 rounded-full border text-xs font-semibold bg-purple-50 border-purple-200 text-purple-700 w-fit">
          <span>↻</span><span>for each in {ti.loopSet}</span>
          {ti.loopExpr && <span className="opacity-70 font-mono">· {ti.loopExpr}</span>}
        </div>
        <ArrowDown size={10} className="text-slate-300 mt-1" />
      </div>
    );
  }
  return null;
}

function StepBlock({ ti, tIdx, isLast, users }) {
  const type = ti.type || 'task';
  const assignedTo = ti.assignedTo || (ti.actionInstances || [])[0]?.assignedTo;
  const user = users.find(u => u.id === assignedTo);
  const skipped = ti.status === 'skipped';
  const isDone = ti.status === 'completed';

  const borderCls = skipped
    ? 'border-dashed border-slate-200 bg-slate-50 opacity-60'
    : isDone ? 'border-green-100 bg-green-50/20' : 'border-slate-200 bg-white';

  return (
    <>
      {tIdx > 0 && <StepGate ti={ti} />}
      <div className={`border rounded-xl overflow-hidden ${borderCls}`}>
        <div className="flex items-center gap-2 px-4 py-3">
          <div className="flex items-center justify-center w-5 h-5 rounded-full bg-slate-100 text-slate-500 text-xs font-bold shrink-0">
            {tIdx + 1}
          </div>
          <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${typeBadgeCls[type]}`}>{typeIcon[type]} {type}</span>
          <span className={`font-medium text-sm flex-1 ${skipped ? 'text-slate-400 line-through' : 'text-slate-700'}`}>{ti.taskName}</span>
          {skipped ? (
            <span className="text-xs text-slate-400 italic">skipped</span>
          ) : user ? (
            <div className="flex items-center gap-1.5">
              <div className="w-5 h-5 rounded-full bg-violet-200 flex items-center justify-center text-violet-700 text-xs font-bold shrink-0">{user.name[0]}</div>
              <span className="text-xs text-slate-500">{user.name}</span>
            </div>
          ) : (
            <span className="text-xs text-slate-400 italic">unassigned</span>
          )}
          {!skipped && statusIcon(ti.status)}
        </div>

        {/* Module results: filled record / validation / SA mapping */}
        {!skipped && ti.taskKind === 'fill' && ti.formData?.name && (
          <div className="px-4 py-2 border-t border-slate-100 text-xs text-slate-500">
            <span className="font-medium text-slate-600">{ti.module}:</span> {ti.formData.name}
            {ti.formData.zip && <span className="text-slate-400"> · ZIP {ti.formData.zip}</span>}
          </div>
        )}
        {ti.taskKind === 'validate' && ti.validation && (
          <div className={`px-4 py-2 border-t text-xs ${ti.validation.ok ? 'border-green-100 bg-green-50/40 text-green-700' : 'border-rose-100 bg-rose-50/40 text-rose-700'}`}>
            {ti.validation.ok
              ? '✓ all records valid'
              : <>✗ invalid: {(ti.validation.results || []).filter(r => !r.ok).map(r => `${r.module} (${r.missing.join(', ')})`).join('; ')}</>}
          </div>
        )}
        {ti.taskKind === 'map' && ti.mapping && (
          <div className="px-4 py-2 border-t border-slate-100 text-xs space-y-0.5">
            {ti.mapping.map((m, i) => (
              <div key={i} className="text-slate-600">
                <span className="font-medium">{m.module}</span> · ZIP {m.zip || '—'} →{' '}
                {m.sa ? <span className="text-green-700">{m.sa.sa} ({m.sa.county})</span> : <span className="text-rose-600">no SA match</span>}
              </div>
            ))}
          </div>
        )}
      </div>
      {!isLast && (
        <div className="flex justify-center py-1">
          <ArrowDown size={14} className="text-slate-300" />
        </div>
      )}
    </>
  );
}

// ── Bulk upload: per-patient lanes ─────────────────────
// System (blue) steps auto-run; the human (pink) review is the only person task.
// The loop body is shown once per uploaded patient, top to bottom.

function actorChip(actor) {
  return actor === 'human'
    ? <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full font-semibold bg-pink-100 text-pink-700"><User size={9} /> human</span>
    : <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full font-semibold bg-sky-100 text-sky-700"><Cpu size={9} /> system</span>;
}

function bulkStatusIcon(status) {
  if (status === 'completed') return <CheckCircle2 size={14} className="text-green-500" />;
  if (status === 'active')    return <Circle size={14} className="text-pink-400 fill-pink-100" />;
  if (status === 'skipped')   return <span className="text-[10px] text-slate-400 italic">skipped</span>;
  return <Circle size={13} className="text-slate-300" />;
}

// One step row in a patient lane. Conditionals show the chosen branch inline.
function BulkStepRow({ ti, users, onComplete }) {
  const skipped = ti.status === 'skipped';
  const isHuman = ti.actor === 'human';
  const user = users.find(u => u.id === ti.assignedTo);
  const isCond = ti.type === 'conditional';

  const tone = skipped
    ? 'border-dashed border-slate-200 bg-slate-50 opacity-60'
    : isHuman
      ? (ti.status === 'active' ? 'border-pink-300 bg-pink-50/50 ring-1 ring-pink-100' : 'border-pink-100 bg-pink-50/20')
      : 'border-sky-100 bg-sky-50/30';

  return (
    <div className={`border rounded-lg ${tone}`}>
      <div className="flex items-center gap-2 px-3 py-2">
        {actorChip(ti.actor)}
        {isCond && <span className="text-amber-500 text-xs">◆</span>}
        <span className={`text-sm flex-1 ${skipped ? 'text-slate-400 line-through' : 'text-slate-700 font-medium'}`}>{ti.taskName}</span>
        {isHuman && !skipped && user && (
          <span className="flex items-center gap-1 text-[11px] text-slate-500">
            <span className="w-4 h-4 rounded-full bg-pink-200 text-pink-700 text-[9px] font-bold flex items-center justify-center">{user.name[0]}</span>
            {user.name}
          </span>
        )}
        {bulkStatusIcon(ti.status)}
      </div>

      {/* conditional outcome */}
      {isCond && ti.status === 'completed' && (
        <div className="px-3 pb-2 -mt-0.5">
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-100">
            {ti.conditionExpr} → <b>{ti.existsDecision ? 'TRUE' : 'FALSE'}</b> ({ti.existsDecision ? ti.branches?.[0]?.split('→')[1]?.trim() : ti.branches?.[1]?.split('→')[1]?.trim()})
          </span>
        </div>
      )}

      {/* human review: show the assembled record + confirm */}
      {isHuman && ti.status === 'active' && (
        <div className="px-3 pb-3 space-y-2">
          <RecordView patient={ti.patientRecord} orders={ti.allOrders} />
          <button
            onClick={() => onComplete({ instanceId: ti._instanceId, taskInstanceId: ti.id, actionInstanceId: ti.actionInstances[0].id })}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-green-600 text-white hover:bg-green-700">
            <CheckCircle2 size={13} /> Confirm record
          </button>
        </div>
      )}
      {isHuman && ti.status === 'completed' && (
        <div className="px-3 pb-2 -mt-0.5 text-[11px] text-green-600">✓ record confirmed</div>
      )}
    </div>
  );
}

function BulkInstanceCard({ instance, users, onComplete }) {
  const [open, setOpen] = useState(true);
  // group task instances by patient index, preserving body order
  const byPatient = {};
  instance.taskInstances.forEach(ti => {
    (byPatient[ti.patientIndex] = byPatient[ti.patientIndex] || []).push({ ...ti, _instanceId: instance.id });
  });
  const patientIdxs = Object.keys(byPatient).map(Number).sort((a, b) => a - b);

  const live = instance.taskInstances.filter(t => t.status !== 'skipped');
  const doneTasks = live.filter(t => t.status === 'completed').length;
  const stage = instanceStage(instance);
  const activePatient = patientIdxs.find(i => byPatient[i].some(t => t.status === 'active' || (t.status !== 'completed' && t.status !== 'skipped')));

  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
      <div className="flex items-start gap-3 p-4">
        <div className="mt-0.5">{statusIcon(instance.status)}</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-slate-800">{instance.workflowName}</span>
            <Badge label={instance.status} type={instance.status} />
            <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-violet-50 text-violet-700 border border-violet-100">
              <UsersIcon size={10} /> {instance.patientCount} patient{instance.patientCount !== 1 ? 's' : ''} · one at a time
            </span>
          </div>
          <div className="flex items-center gap-3 mt-1 text-xs text-slate-400">
            <span className="flex items-center gap-1"><Clock size={10} /> {new Date(instance.launchedAt).toLocaleString()}</span>
            <span>{doneTasks}/{live.length} steps</span>
            {instance.status === 'running' && activePatient != null && <span>· now on patient {activePatient + 1}</span>}
          </div>
          <StageHeader stage={stage} />
        </div>
        <button onClick={() => setOpen(o => !o)}
          className="shrink-0 px-2.5 py-1 rounded-lg text-xs font-medium bg-slate-100 text-slate-600 hover:bg-slate-200 flex items-center gap-1">
          {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />} {open ? 'Hide' : 'Show'} patients
        </button>
      </div>

      {open && (
        <div className="border-t border-slate-100 bg-slate-50/40 p-4 space-y-3">
          {/* legend */}
          <div className="flex items-center gap-3 text-[11px] text-slate-500">
            <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-sky-200 border border-sky-300" /> system (auto)</span>
            <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-pink-200 border border-pink-300" /> human (review)</span>
          </div>
          {patientIdxs.map(pIdx => {
            const rows = byPatient[pIdx];
            const pname = rows[0]?.patientName || `Patient ${pIdx + 1}`;
            const laneActive = rows.some(t => t.status === 'active');
            const laneDone = rows.filter(t => t.status !== 'skipped').every(t => t.status === 'completed');
            return (
              <div key={pIdx} className={`rounded-xl border p-3 ${laneActive ? 'border-pink-200 bg-pink-50/20' : laneDone ? 'border-green-100 bg-green-50/20' : 'border-slate-200 bg-white'}`}>
                <div className="flex items-center gap-2 mb-2">
                  <span className="w-6 h-6 rounded-full bg-violet-200 text-violet-700 text-xs font-bold flex items-center justify-center">{pIdx + 1}</span>
                  <span className="font-semibold text-sm text-slate-800">{pname}</span>
                  {laneActive && <span className="text-[10px] px-2 py-0.5 rounded-full bg-pink-100 text-pink-700 font-semibold">in progress</span>}
                  {laneDone && <span className="text-[10px] px-2 py-0.5 rounded-full bg-green-100 text-green-700 font-semibold">done</span>}
                  {!laneActive && !laneDone && <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 font-semibold">waiting</span>}
                </div>
                <div className="space-y-1.5">
                  {rows.map(ti => (
                    <BulkStepRow key={ti.id} ti={ti} users={users} onComplete={onComplete} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function InstanceCard({ instance, users }) {
  const [view, setView] = useState('flow'); // 'flow' | 'detail' | 'collapsed'

  // Skipped (not-taken branch) steps are excluded from progress counts.
  const liveTasks = instance.taskInstances.filter(t => t.status !== 'skipped');
  const totalActions = liveTasks.reduce((s, t) => s + t.actionInstances.filter(a => a.status !== 'skipped').length, 0);
  const doneActions = liveTasks.reduce((s, t) => s + t.actionInstances.filter(a => a.status === 'completed').length, 0);
  const totalTasks = liveTasks.length;
  const doneTasks = liveTasks.filter(t => t.status === 'completed').length;
  const stage = instanceStage(instance);

  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
      <div className="flex items-start gap-3 p-4">
        <div className="mt-0.5">{statusIcon(instance.status)}</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-slate-800">{instance.workflowName}</span>
            <Badge label={instance.status} type={instance.status} />
          </div>
          <div className="flex items-center gap-3 mt-1 text-xs text-slate-400">
            <span className="flex items-center gap-1"><Clock size={10} /> {new Date(instance.launchedAt).toLocaleString()}</span>
            <span>{doneTasks}/{totalTasks} steps</span>
            <span>{doneActions}/{totalActions} sub-steps</span>
          </div>
          <StageHeader stage={stage} />
          <div className="mt-2">{progressBar(doneActions, totalActions)}</div>
        </div>

        {/* view toggle — clicking the active button collapses */}
        <div className="flex items-center gap-1 bg-slate-100 rounded-lg p-0.5 shrink-0">
          <button onClick={() => setView(v => v === 'flow' ? 'collapsed' : 'flow')}
            className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors flex items-center gap-1 ${view === 'flow' ? 'bg-white shadow-sm text-slate-800' : 'text-slate-500 hover:text-slate-700'}`}>
            <GitBranch size={11} /> Flow
          </button>
          <button onClick={() => setView(v => v === 'detail' ? 'collapsed' : 'detail')}
            className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors flex items-center gap-1 ${view === 'detail' ? 'bg-white shadow-sm text-slate-800' : 'text-slate-500 hover:text-slate-700'}`}>
            {view === 'detail' ? <ChevronUp size={11} /> : <ChevronDown size={11} />} Detail
          </button>
        </div>
      </div>

      {view === 'flow' && (
        <div className="border-t border-slate-100 bg-slate-50/40">
          <WorkflowFlowChart nodes={nodesFromInstance(instance, users)} endDone={instance.status === 'completed'} />
        </div>
      )}

      {view === 'detail' && (
        <div className="border-t border-slate-100 px-4 py-3 bg-slate-50/40 space-y-0">
          {instance.taskInstances.map((ti, tIdx) => (
            <StepBlock key={ti.id} ti={ti} tIdx={tIdx} isLast={tIdx === instance.taskInstances.length - 1} users={users} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Who is doing what ─────────────────────────────────
// One task card with description + status + one-click Complete.
function TaskCard({ item, onComplete }) {
  const statusLabel = item.status === 'completed' ? 'done' : item.status === 'active' ? 'in progress' : 'waiting';
  const statusCls = item.status === 'completed' ? 'bg-green-100 text-green-700'
    : item.status === 'active' ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-500';
  return (
    <div className="bg-white rounded-xl border border-slate-100 p-3 shadow-sm">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${typeBadgeCls[item.type || 'task']}`}>{typeIcon[item.type || 'task']}</span>
            <span className="font-semibold text-slate-800 text-sm">{item.taskName}</span>
            <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${statusCls}`}>{statusLabel}</span>
          </div>
          <div className="text-xs text-slate-500 mt-1">{item.description || 'No description.'}</div>
          <div className="text-[11px] text-slate-400 mt-1">{item.workflowName}</div>
        </div>
        <button
          onClick={() => onComplete(item)}
          className="shrink-0 flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold bg-green-50 text-green-700 border border-green-200 hover:bg-green-100 transition-colors">
          <CheckCircle2 size={13} /> Complete
        </button>
      </div>
    </div>
  );
}

function PeoplePanel({ instances, users, onComplete }) {
  const workByUser = {};
  for (const inst of instances) {
    if (inst.status !== 'running') continue;
    for (const ti of inst.taskInstances) {
      if (ti.status !== 'active') continue;
      const ai = (ti.actionInstances || [])[0];
      const assignedTo = ti.assignedTo || ai?.assignedTo;
      if (!assignedTo) continue;
      (workByUser[assignedTo] = workByUser[assignedTo] || []).push({
        instanceId: inst.id,
        taskInstanceId: ti.id,
        actionInstanceId: ai?.id,
        workflowName: inst.workflowName,
        taskName: ti.taskName,
        description: ti.description,
        type: ti.type,
        status: ti.status,
      });
    }
  }
  const entries = Object.entries(workByUser);
  if (entries.length === 0) {
    return <div className="text-center py-8 text-slate-400 text-sm">No active tasks right now.</div>;
  }
  return (
    <div className="space-y-3">
      {entries.map(([userId, items]) => {
        const user = users.find(u => u.id === userId);
        if (!user) return null;
        return (
          <div key={userId} className="bg-slate-50/60 rounded-2xl border border-slate-100 p-4">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-8 h-8 rounded-full bg-violet-200 flex items-center justify-center text-violet-700 font-bold text-sm">{user.name[0]}</div>
              <div>
                <div className="font-semibold text-slate-800 text-sm">{user.name}</div>
                <div className="text-xs text-slate-400">{items.length} active task{items.length !== 1 ? 's' : ''}</div>
              </div>
            </div>
            <div className="grid md:grid-cols-2 gap-2">
              {items.map((item, i) => (
                <TaskCard key={i} item={item} onComplete={onComplete} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function StatCard({ label, value, sub, color, onClick, active }) {
  const colors = {
    violet: 'bg-violet-50 text-violet-700 border-violet-100',
    amber:  'bg-amber-50 text-amber-700 border-amber-100',
    green:  'bg-green-50 text-green-700 border-green-100',
    slate:  'bg-slate-50 text-slate-700 border-slate-100',
  };
  const clickable = typeof onClick === 'function';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!clickable}
      className={`text-left rounded-xl border p-4 transition-all ${colors[color] || colors.slate} ${clickable ? 'cursor-pointer hover:shadow-md hover:-translate-y-0.5' : 'cursor-default'} ${active ? 'ring-2 ring-offset-1 ring-current shadow-md' : ''}`}
    >
      <div className="text-2xl font-bold">{value}</div>
      <div className="text-sm font-medium mt-0.5 flex items-center gap-1">
        {label}
        {clickable && <ChevronDown size={12} className={`transition-transform ${active ? 'rotate-180' : ''}`} />}
      </div>
      {sub && <div className="text-xs opacity-60 mt-0.5">{sub}</div>}
    </button>
  );
}

// Every (non-skipped) task across all running instances. A task is atomic:
// one assignee, one status. e.g. 3 runs of a 3-step workflow → up to 9 tasks
// (fewer if some branches were skipped).
function getActiveTaskGroups(instances) {
  const groups = [];
  for (const inst of instances) {
    if (inst.status !== 'running') continue;
    for (const ti of inst.taskInstances) {
      if (ti.status === 'skipped') continue;
      const assignedTo = ti.assignedTo || (ti.actionInstances || [])[0]?.assignedTo || null;
      groups.push({
        key: `${inst.id}-${ti.id}`,
        workflowName: inst.workflowName,
        taskName: ti.taskName,
        type: ti.type || 'task',
        status: ti.status,            // 'active' | 'pending' | 'completed'
        assignedTo,
      });
    }
  }
  return groups;
}

function ActiveTasksPanel({ instances, users }) {
  const groups = getActiveTaskGroups(instances);
  if (groups.length === 0) {
    return (
      <div className="text-center py-10 text-slate-400 text-sm border border-dashed border-slate-200 rounded-2xl">
        No active tasks right now. Launch a workflow to see live work here.
      </div>
    );
  }
  return (
    <div className="grid md:grid-cols-2 gap-3">
      {groups.map(g => {
        const u = users.find(x => x.id === g.assignedTo);
        return (
        <div key={g.key} className="bg-white rounded-2xl border border-slate-100 shadow-sm p-4">
          <div className="flex items-center gap-2 flex-wrap mb-2">
            <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${typeBadgeCls[g.type]}`}>{typeIcon[g.type]} {g.type}</span>
            <span className="font-semibold text-slate-800 text-sm">{g.taskName}</span>
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
              g.status === 'completed' ? 'bg-green-100 text-green-700'
              : g.status === 'active' ? 'bg-amber-100 text-amber-700'
              : 'bg-slate-100 text-slate-500'
            }`}>
              {g.status === 'active' ? 'in progress' : g.status === 'completed' ? 'done' : 'waiting'}
            </span>
          </div>
          <div className="text-xs text-slate-400 mb-3">{g.workflowName}</div>

          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-500">
              {g.status === 'pending' ? 'not started yet · ' : 'assigned to '}
            </span>
            {u ? (
              <span className="flex items-center gap-1 bg-violet-50 border border-violet-200 rounded-full pl-1 pr-2 py-0.5">
                <span className="w-4 h-4 rounded-full bg-violet-200 text-violet-800 text-[10px] font-bold flex items-center justify-center">{u.name[0]}</span>
                <span className="text-xs text-violet-800 font-medium">{u.name}</span>
              </span>
            ) : (
              <span className="text-xs text-slate-400 italic">unassigned</span>
            )}
          </div>
        </div>
        );
      })}
    </div>
  );
}

export default function Orchestrator() {
  const [instances, setInstances] = useState([]);
  const [users, setUsers] = useState([]);
  const [filter, setFilter] = useState('all');
  const [tab, setTab] = useState('instances');
  const [showActiveTasks, setShowActiveTasks] = useState(false);

  function refresh() {
    setInstances(getInstances());
    setUsers(getUsers());
  }

  function handleComplete(item) {
    if (!item.actionInstanceId) return;
    completeActionInstance(item.instanceId, item.taskInstanceId, item.actionInstanceId, '');
    refresh();
  }

  useEffect(() => { refresh(); }, []);

  const running = instances.filter(i => i.status === 'running');
  const completed = instances.filter(i => i.status === 'completed');
  const totalActiveActions = running.reduce((s, inst) => s + inst.taskInstances.reduce((ts, t) => ts + t.actionInstances.filter(a => a.status === 'active').length, 0), 0);
  const totalDoneActions = instances.reduce((s, inst) => s + inst.taskInstances.reduce((ts, t) => ts + t.actionInstances.filter(a => a.status === 'completed').length, 0), 0);
  const activeTaskGroups = getActiveTaskGroups(instances);

  const filtered = instances.filter(i => {
    if (filter === 'running') return i.status === 'running';
    if (filter === 'completed') return i.status === 'completed';
    return true;
  }).sort((a, b) => new Date(b.launchedAt) - new Date(a.launchedAt));

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Orchestrator</h1>
          <p className="text-sm text-slate-500 mt-1">Runs workflows from triggers, routes & auto-assigns tasks to people</p>
        </div>
        <button onClick={refresh} className="flex items-center gap-2 px-3 py-2 text-sm text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50">
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-4">
        <StatCard label="Total Runs" value={instances.length} sub="all time" color="slate" />
        <StatCard label="Active" value={running.length} sub="workflows running" color="amber" />
        <StatCard label="Completed" value={completed.length} sub="workflows done" color="green" />
        <StatCard
          label="Active Tasks"
          value={activeTaskGroups.length}
          sub="tasks across running runs"
          color="amber"
          active={showActiveTasks}
          onClick={() => setShowActiveTasks(s => !s)}
        />
        <StatCard label="In Progress" value={totalActiveActions} sub={`${totalDoneActions} done`} color="violet" />
      </div>

      {showActiveTasks && (
        <div className="mb-6 bg-slate-50/60 border border-slate-100 rounded-2xl p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-slate-700">Active Tasks · who is working on what</h2>
            <button onClick={() => setShowActiveTasks(false)} className="text-xs text-slate-400 hover:text-slate-600">Close ✕</button>
          </div>
          <ActiveTasksPanel instances={instances} users={users} />
        </div>
      )}

      <div className="flex gap-1 mb-4 bg-slate-100 p-1 rounded-xl w-fit">
        {[['instances', 'Workflow Runs'], ['people', 'Who is doing what']].map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)}
            className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${tab === key ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'instances' && (
        <>
          <div className="flex gap-2 mb-4">
            {[['all', 'All'], ['running', 'Running'], ['completed', 'Completed']].map(([v, l]) => (
              <button key={v} onClick={() => setFilter(v)}
                className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${filter === v ? 'bg-violet-600 text-white border-violet-600' : 'border-slate-200 text-slate-500 hover:border-violet-300'}`}>
                {l}
              </button>
            ))}
          </div>
          {filtered.length === 0 ? (
            <div className="text-center py-16 text-slate-400">
              <Activity size={40} className="mx-auto mb-3 opacity-30" />
              <p>No workflow runs yet. Fire a trigger from the Triggers page.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {filtered.map(inst => inst.bulkUpload
                ? <BulkInstanceCard key={inst.id} instance={inst} users={users} onComplete={handleComplete} />
                : <InstanceCard key={inst.id} instance={inst} users={users} />)}
            </div>
          )}
        </>
      )}

      {tab === 'people' && <PeoplePanel instances={instances} users={users} onComplete={handleComplete} />}
    </div>
  );
}
