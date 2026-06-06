import { useState, useEffect } from 'react';
import { Activity, ChevronDown, ChevronUp, CheckCircle2, Clock, Circle, AlertCircle, RefreshCw, Lock, ArrowDown, Columns, GitBranch } from 'lucide-react';
import Badge from '../../components/Badge';
import { getInstances, getUsers } from '../../store';

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

// ── Flowchart view ─────────────────────────────────────

function FlowArrow({ label, condition, conditionExpr }) {
  const condColors = {
    'if/else': 'bg-amber-50 border-amber-300 text-amber-700',
    'switch':  'bg-blue-50 border-blue-300 text-blue-700',
    'loop':    'bg-purple-50 border-purple-300 text-purple-700',
  };
  return (
    <div className="flex flex-col items-center gap-0 select-none">
      <div className="w-px h-5 bg-slate-300" />
      {condition && condition !== 'none' ? (
        <>
          {/* diamond gate */}
          <div className={`border rounded px-2 py-0.5 text-xs font-medium flex items-center gap-1 ${condColors[condition] || 'bg-slate-50 border-slate-300 text-slate-600'}`}>
            ◆ <span className="capitalize">{condition}</span>
            {conditionExpr && <span className="font-mono opacity-70 ml-1">{conditionExpr}</span>}
          </div>
          <div className="w-px h-5 bg-slate-300" />
        </>
      ) : null}
      <svg width="10" height="6" viewBox="0 0 10 6" className="text-slate-300">
        <path d="M0 0 L5 6 L10 0" fill="currentColor" />
      </svg>
    </div>
  );
}

function FlowActionChip({ ai, users }) {
  const user = users.find(u => u.id === ai.assignedTo);
  const statusCls =
    ai.status === 'completed' ? 'border-green-200 bg-green-50' :
    ai.status === 'active'    ? 'border-amber-200 bg-amber-50' :
    'border-slate-200 bg-white opacity-50';

  return (
    <div className={`border rounded-lg px-3 py-1.5 flex items-center gap-2 text-xs min-w-[140px] ${statusCls}`}>
      {statusIcon(ai.status)}
      <span className={`flex-1 font-medium ${ai.status === 'completed' ? 'line-through text-slate-400' : 'text-slate-700'}`}>
        {ai.actionName}
      </span>
      {user && (
        <div className="w-5 h-5 rounded-full bg-violet-200 flex items-center justify-center text-violet-700 text-xs font-bold shrink-0">
          {user.name[0]}
        </div>
      )}
    </div>
  );
}

function FlowTaskNode({ ti, tIdx, users }) {
  const mode = ti.executionMode || 'sequential';
  const done = ti.actionInstances.filter(a => a.status === 'completed').length;
  const total = ti.actionInstances.length;

  const borderCls =
    ti.status === 'completed' ? 'border-green-300 bg-green-50/40 shadow-green-100' :
    ti.actionInstances.some(a => a.status === 'active') ? 'border-violet-300 bg-violet-50/40 shadow-violet-100 ring-2 ring-violet-100' :
    'border-slate-200 bg-white';

  return (
    <div className={`border-2 rounded-2xl shadow-sm overflow-hidden min-w-[200px] ${borderCls}`}>
      {/* Task header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-100 bg-white/70">
        <div className="w-5 h-5 rounded-full bg-violet-600 text-white text-xs font-bold flex items-center justify-center shrink-0">
          {tIdx + 1}
        </div>
        <span className="font-semibold text-slate-800 text-sm flex-1 truncate">{ti.taskName}</span>
        <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${mode === 'parallel' ? 'bg-teal-100 text-teal-700' : 'bg-slate-100 text-slate-600'}`}>
          {mode === 'parallel' ? '⫶' : '↓'} {mode}
        </span>
        <span className="text-xs text-slate-400">{done}/{total}</span>
      </div>

      {/* Actions */}
      <div className={`p-2 ${mode === 'parallel' ? 'flex flex-row gap-2 flex-wrap' : 'flex flex-col gap-1.5'}`}>
        {mode === 'sequential' && ti.actionInstances.map((ai, aIdx) => (
          <div key={ai.id} className="flex flex-col items-stretch gap-0">
            <FlowActionChip ai={ai} users={users} />
            {aIdx < ti.actionInstances.length - 1 && (
              <div className="flex justify-center">
                <div className="flex flex-col items-center">
                  <div className="w-px h-2 bg-slate-200" />
                  <svg width="8" height="5" viewBox="0 0 10 6" className="text-slate-300">
                    <path d="M0 0 L5 6 L10 0" fill="currentColor" />
                  </svg>
                </div>
              </div>
            )}
          </div>
        ))}
        {mode === 'parallel' && ti.actionInstances.map(ai => (
          <FlowActionChip key={ai.id} ai={ai} users={users} />
        ))}
      </div>
    </div>
  );
}

function FlowStartEnd({ label, done }) {
  return (
    <div className={`rounded-full px-6 py-2 text-sm font-bold border-2 ${done ? 'border-green-400 bg-green-50 text-green-700' : 'border-violet-400 bg-violet-50 text-violet-700'}`}>
      {label}
    </div>
  );
}

function FlowChart({ instance, users }) {
  return (
    <div className="flex flex-col items-center py-6 px-4 overflow-x-auto">
      <FlowStartEnd label="START" done={false} />

      {instance.taskInstances.map((ti, tIdx) => (
        <div key={ti.id} className="flex flex-col items-center w-full">
          <FlowArrow
            condition={tIdx > 0 ? ti.condition : null}
            conditionExpr={ti.conditionExpr}
          />
          <FlowTaskNode ti={ti} tIdx={tIdx} users={users} />
        </div>
      ))}

      <div className="flex flex-col items-center">
        <FlowArrow condition={null} conditionExpr={null} />
        <FlowStartEnd label="END" done={instance.status === 'completed'} />
      </div>
    </div>
  );
}

// ── List view (existing detail view) ──────────────────

function ConditionGate({ condition, conditionExpr }) {
  if (!condition || condition === 'none') return null;
  const colors = {
    'if/else': 'bg-amber-50 border-amber-200 text-amber-700',
    'switch':  'bg-blue-50 border-blue-200 text-blue-700',
    'loop':    'bg-purple-50 border-purple-200 text-purple-700',
  };
  const cls = colors[condition] || 'bg-slate-50 border-slate-200 text-slate-600';
  return (
    <div className="flex items-center gap-2 px-5 py-1.5">
      <div className="w-px h-4 bg-slate-200 mx-2" />
      <div className={`flex items-center gap-2 px-3 py-1 rounded-full border text-xs font-medium ${cls}`}>
        <span className="capitalize">{condition}</span>
        {conditionExpr && <span className="opacity-70 font-mono">{conditionExpr}</span>}
      </div>
      <ArrowDown size={10} className="text-slate-300" />
    </div>
  );
}

function ActionRow({ ai, users, isLast, mode }) {
  const user = users.find(u => u.id === ai.assignedTo);
  const isBlocked = ai.status === 'blocked';
  const isDone = ai.status === 'completed';

  return (
    <div className={`flex items-center gap-3 text-sm transition-colors ${isBlocked ? 'opacity-40' : ''}`}>
      {mode === 'sequential' && (
        <div className="flex flex-col items-center w-4 shrink-0 self-stretch">
          <div className="w-px flex-1 bg-slate-200" />
          {!isLast && <div className="w-px flex-1 bg-slate-200" />}
        </div>
      )}
      <div className={`flex items-center gap-2 flex-1 py-2 ${mode === 'parallel' ? 'bg-white border border-slate-100 rounded-xl px-3 shadow-sm' : 'pr-4'}`}>
        <div className="shrink-0">{statusIcon(ai.status)}</div>
        <span className={`flex-1 text-sm ${isDone ? 'line-through text-slate-400' : isBlocked ? 'text-slate-400' : 'text-slate-700'}`}>
          {ai.actionName}
        </span>
        <Badge label={ai.executorType} type={ai.executorType?.split('+')[0]} />
        {isBlocked ? (
          <span className="text-xs text-slate-300 italic">waiting</span>
        ) : user ? (
          <div className="flex items-center gap-1.5 min-w-0">
            <div className="w-5 h-5 rounded-full bg-violet-200 flex items-center justify-center text-violet-700 text-xs font-bold shrink-0">
              {user.name[0]}
            </div>
            <span className="text-xs text-slate-500 truncate">{user.name}</span>
          </div>
        ) : (
          <span className="text-xs text-slate-400 italic">unassigned</span>
        )}
        {isDone && ai.completedAt && (
          <span className="text-xs text-slate-400 shrink-0">
            {new Date(ai.completedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
        )}
      </div>
    </div>
  );
}

function TaskBlock({ ti, tIdx, isLast, users }) {
  const mode = ti.executionMode || 'sequential';
  const taskDone = ti.actionInstances.filter(a => a.status === 'completed').length;
  const taskTotal = ti.actionInstances.length;

  return (
    <>
      {tIdx > 0 && ti.condition && ti.condition !== 'none' && (
        <ConditionGate condition={ti.condition} conditionExpr={ti.conditionExpr} />
      )}
      <div className={`border rounded-xl overflow-hidden ${ti.status === 'completed' ? 'border-green-100 bg-green-50/20' : 'border-slate-200 bg-white'}`}>
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-slate-100">
          <div className="flex items-center justify-center w-5 h-5 rounded-full bg-violet-100 text-violet-700 text-xs font-bold shrink-0">
            {tIdx + 1}
          </div>
          <span className="font-medium text-slate-700 text-sm flex-1">{ti.taskName}</span>
          <div className={`flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium ${mode === 'parallel' ? 'bg-teal-50 text-teal-600 border border-teal-100' : 'bg-slate-50 text-slate-500 border border-slate-200'}`}>
            {mode === 'parallel' ? <Columns size={10} /> : <ArrowDown size={10} />}
            {mode}
          </div>
          <span className="text-xs text-slate-400">{taskDone}/{taskTotal}</span>
          {statusIcon(ti.status)}
        </div>
        <div className={`px-3 py-2 ${mode === 'parallel' ? 'flex flex-wrap gap-2' : 'space-y-0'}`}>
          {mode === 'parallel'
            ? ti.actionInstances.map(ai => (
                <div key={ai.id} className="flex-1 min-w-[140px]">
                  <ActionRow ai={ai} users={users} isLast={false} mode="parallel" />
                </div>
              ))
            : ti.actionInstances.map((ai, aIdx) => (
                <ActionRow key={ai.id} ai={ai} users={users} isLast={aIdx === ti.actionInstances.length - 1} mode="sequential" />
              ))
          }
        </div>
      </div>
      {!isLast && (
        <div className="flex justify-center py-1">
          <ArrowDown size={14} className="text-slate-300" />
        </div>
      )}
    </>
  );
}

function InstanceCard({ instance, users }) {
  const [view, setView] = useState('detail'); // 'detail' | 'flow'

  const totalActions = instance.taskInstances.reduce((s, t) => s + t.actionInstances.length, 0);
  const doneActions = instance.taskInstances.reduce((s, t) => s + t.actionInstances.filter(a => a.status === 'completed').length, 0);
  const totalTasks = instance.taskInstances.length;
  const doneTasks = instance.taskInstances.filter(t => t.status === 'completed').length;

  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
      {/* Header */}
      <div className="flex items-start gap-3 p-4">
        <div className="mt-0.5">{statusIcon(instance.status)}</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-slate-800">{instance.workflowName}</span>
            <Badge label={instance.status} type={instance.status} />
          </div>
          <div className="flex items-center gap-3 mt-1 text-xs text-slate-400">
            <span className="flex items-center gap-1"><Clock size={10} /> {new Date(instance.launchedAt).toLocaleString()}</span>
            <span>{doneTasks}/{totalTasks} tasks</span>
            <span>{doneActions}/{totalActions} actions</span>
          </div>
          <div className="mt-2">{progressBar(doneActions, totalActions)}</div>
        </div>

        {/* view toggle */}
        <div className="flex items-center gap-1 bg-slate-100 rounded-lg p-0.5 shrink-0">
          <button onClick={() => setView('detail')}
            className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors flex items-center gap-1 ${view === 'detail' ? 'bg-white shadow-sm text-slate-800' : 'text-slate-500 hover:text-slate-700'}`}>
            <ChevronDown size={11} /> Detail
          </button>
          <button onClick={() => setView(v => v === 'flow' ? 'detail' : 'flow')}
            className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors flex items-center gap-1 ${view === 'flow' ? 'bg-white shadow-sm text-slate-800' : 'text-slate-500 hover:text-slate-700'}`}>
            <GitBranch size={11} /> Flow
          </button>
        </div>
      </div>

      {/* Detail view */}
      {view === 'detail' && (
        <div className="border-t border-slate-100 px-4 py-3 bg-slate-50/40 space-y-0">
          {instance.taskInstances.map((ti, tIdx) => (
            <TaskBlock key={ti.id} ti={ti} tIdx={tIdx} isLast={tIdx === instance.taskInstances.length - 1} users={users} />
          ))}
        </div>
      )}

      {/* Flowchart view */}
      {view === 'flow' && (
        <div className="border-t border-slate-100 bg-slate-50/40">
          <FlowChart instance={instance} users={users} />
        </div>
      )}
    </div>
  );
}

// ── Who is doing what ─────────────────────────────────
function PeoplePanel({ instances, users }) {
  const workByUser = {};
  for (const inst of instances) {
    if (inst.status !== 'running') continue;
    for (const ti of inst.taskInstances) {
      for (const ai of ti.actionInstances) {
        if (!ai.assignedTo || ai.status !== 'active') continue;
        if (!workByUser[ai.assignedTo]) workByUser[ai.assignedTo] = [];
        workByUser[ai.assignedTo].push({ workflowName: inst.workflowName, taskName: ti.taskName, actionName: ai.actionName });
      }
    }
  }
  const entries = Object.entries(workByUser);
  if (entries.length === 0) {
    return <div className="text-center py-8 text-slate-400 text-sm">No active human tasks right now.</div>;
  }
  return (
    <div className="space-y-3">
      {entries.map(([userId, items]) => {
        const user = users.find(u => u.id === userId);
        if (!user) return null;
        return (
          <div key={userId} className="bg-white rounded-xl border border-slate-100 p-4 shadow-sm">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-8 h-8 rounded-full bg-violet-200 flex items-center justify-center text-violet-700 font-bold text-sm">{user.name[0]}</div>
              <div>
                <div className="font-semibold text-slate-800 text-sm">{user.name}</div>
                <div className="text-xs text-slate-400">{items.length} active action{items.length !== 1 ? 's' : ''}</div>
              </div>
            </div>
            <div className="space-y-1.5">
              {items.map((item, i) => (
                <div key={i} className="flex items-center gap-2 text-xs text-slate-600 bg-slate-50 rounded-lg px-3 py-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
                  <span className="font-medium flex-1">{item.actionName}</span>
                  <span className="text-slate-400">{item.workflowName} › {item.taskName}</span>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function StatCard({ label, value, sub, color }) {
  const colors = {
    violet: 'bg-violet-50 text-violet-700 border-violet-100',
    amber:  'bg-amber-50 text-amber-700 border-amber-100',
    green:  'bg-green-50 text-green-700 border-green-100',
    slate:  'bg-slate-50 text-slate-700 border-slate-100',
  };
  return (
    <div className={`rounded-xl border p-4 ${colors[color] || colors.slate}`}>
      <div className="text-2xl font-bold">{value}</div>
      <div className="text-sm font-medium mt-0.5">{label}</div>
      {sub && <div className="text-xs opacity-60 mt-0.5">{sub}</div>}
    </div>
  );
}

export default function Orchestrator() {
  const [instances, setInstances] = useState([]);
  const [users, setUsers] = useState([]);
  const [filter, setFilter] = useState('all');
  const [tab, setTab] = useState('instances');

  function refresh() {
    setInstances(getInstances());
    setUsers(getUsers());
  }

  useEffect(() => { refresh(); }, []);

  const running = instances.filter(i => i.status === 'running');
  const completed = instances.filter(i => i.status === 'completed');
  const totalActiveActions = running.reduce((s, inst) => s + inst.taskInstances.reduce((ts, t) => ts + t.actionInstances.filter(a => a.status === 'active').length, 0), 0);
  const totalDoneActions = instances.reduce((s, inst) => s + inst.taskInstances.reduce((ts, t) => ts + t.actionInstances.filter(a => a.status === 'completed').length, 0), 0);

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
          <p className="text-sm text-slate-500 mt-1">Live view of all workflow runs and who is doing what</p>
        </div>
        <button onClick={refresh} className="flex items-center gap-2 px-3 py-2 text-sm text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50">
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <StatCard label="Total Runs" value={instances.length} sub="all time" color="slate" />
        <StatCard label="Active" value={running.length} sub="workflows running" color="amber" />
        <StatCard label="Completed" value={completed.length} sub="workflows done" color="green" />
        <StatCard label="Active Actions" value={totalActiveActions} sub={`${totalDoneActions} done`} color="violet" />
      </div>

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
              <p>No workflow runs yet. Launch a workflow from the Workflows page.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {filtered.map(inst => <InstanceCard key={inst.id} instance={inst} users={users} />)}
            </div>
          )}
        </>
      )}

      {tab === 'people' && <PeoplePanel instances={instances} users={users} />}
    </div>
  );
}
