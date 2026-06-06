import { useState, useEffect } from 'react';
import { Activity, ChevronDown, ChevronUp, CheckCircle2, Clock, Circle, AlertCircle, RefreshCw, Lock, ArrowDown, GitBranch } from 'lucide-react';
import Badge from '../../components/Badge';
import WorkflowFlowChart, { nodesFromInstance } from '../../components/WorkflowFlowChart';
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

function ActionRow({ ai, users }) {
  const user = users.find(u => u.id === ai.assignedTo);
  const isBlocked = ai.status === 'blocked';
  const isDone = ai.status === 'completed';

  return (
    <div className={`flex items-center gap-3 text-sm transition-colors ${isBlocked ? 'opacity-40' : ''}`}>
      <div className="flex items-center gap-2 flex-1 py-2 pr-4">
        <div className="shrink-0">{statusIcon(ai.status)}</div>
        <span className={`flex-1 text-sm ${isDone ? 'line-through text-slate-400' : isBlocked ? 'text-slate-400' : 'text-slate-700'}`}>
          {ai.actionName}
        </span>
        {user ? (
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

function StepBlock({ ti, tIdx, isLast, users }) {
  const done = ti.actionInstances.filter(a => a.status === 'completed').length;
  const total = ti.actionInstances.length;
  const type = ti.type || 'task';

  return (
    <>
      {tIdx > 0 && <StepGate ti={ti} />}
      <div className={`border rounded-xl overflow-hidden ${ti.status === 'completed' ? 'border-green-100 bg-green-50/20' : 'border-slate-200 bg-white'}`}>
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-slate-100">
          <div className="flex items-center justify-center w-5 h-5 rounded-full bg-slate-100 text-slate-500 text-xs font-bold shrink-0">
            {tIdx + 1}
          </div>
          <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${typeBadgeCls[type]}`}>{typeIcon[type]} {type}</span>
          <span className="font-medium text-slate-700 text-sm flex-1">{ti.taskName}</span>
          <span className="text-xs text-slate-400">{done}/{total}</span>
          {statusIcon(ti.status)}
        </div>
        <div className="px-3 py-2 space-y-0">
          {ti.actionInstances.map(ai => (
            <ActionRow key={ai.id} ai={ai} users={users} />
          ))}
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
  const [view, setView] = useState('flow'); // 'flow' | 'detail' | 'collapsed'

  const totalActions = instance.taskInstances.reduce((s, t) => s + t.actionInstances.length, 0);
  const doneActions = instance.taskInstances.reduce((s, t) => s + t.actionInstances.filter(a => a.status === 'completed').length, 0);
  const totalTasks = instance.taskInstances.length;
  const doneTasks = instance.taskInstances.filter(t => t.status === 'completed').length;

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
    return <div className="text-center py-8 text-slate-400 text-sm">No active tasks right now.</div>;
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
                <div className="text-xs text-slate-400">{items.length} active sub-step{items.length !== 1 ? 's' : ''}</div>
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

// Aggregate every currently-active step across all running instances.
function getActiveTaskGroups(instances) {
  const groups = [];
  for (const inst of instances) {
    if (inst.status !== 'running') continue;
    for (const ti of inst.taskInstances) {
      const activeActions = ti.actionInstances.filter(a => a.status === 'active');
      if (activeActions.length === 0) continue;
      const done = ti.actionInstances.filter(a => a.status === 'completed').length;
      const total = ti.actionInstances.length;
      const peopleIds = [...new Set(activeActions.map(a => a.assignedTo).filter(Boolean))];
      groups.push({
        key: `${inst.id}-${ti.id}`,
        workflowName: inst.workflowName,
        taskName: ti.taskName,
        type: ti.type || 'task',
        done, total,
        activeActions,
        peopleIds,
        actionInstances: ti.actionInstances,
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
      {groups.map(g => (
        <div key={g.key} className="bg-white rounded-2xl border border-slate-100 shadow-sm p-4">
          <div className="flex items-start gap-2 mb-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${typeBadgeCls[g.type]}`}>{typeIcon[g.type]} {g.type}</span>
                <span className="font-semibold text-slate-800 text-sm">{g.taskName}</span>
              </div>
              <div className="text-xs text-slate-400 mt-0.5">{g.workflowName}</div>
            </div>
          </div>

          <div className="flex items-center gap-2 mb-3 flex-wrap">
            <span className="text-xs text-slate-500">
              {g.peopleIds.length === 0
                ? 'unassigned'
                : `${g.peopleIds.length} ${g.peopleIds.length === 1 ? 'person' : 'people'} working:`}
            </span>
            {g.peopleIds.map(pid => {
              const u = users.find(x => x.id === pid);
              if (!u) return null;
              return (
                <span key={pid} className="flex items-center gap-1 bg-amber-50 border border-amber-200 rounded-full pl-1 pr-2 py-0.5">
                  <span className="w-4 h-4 rounded-full bg-amber-200 text-amber-800 text-[10px] font-bold flex items-center justify-center">{u.name[0]}</span>
                  <span className="text-xs text-amber-800 font-medium">{u.name}</span>
                </span>
              );
            })}
          </div>

          <div className="mb-3">{progressBar(g.done, g.total)}</div>

          <div className="space-y-1.5">
            {g.actionInstances.map(ai => {
              const u = users.find(x => x.id === ai.assignedTo);
              return (
                <div key={ai.id} className="flex items-center gap-2 text-xs bg-slate-50 rounded-lg px-3 py-1.5">
                  <span className="shrink-0">{statusIcon(ai.status)}</span>
                  <span className={`flex-1 ${ai.status === 'completed' ? 'line-through text-slate-400' : ai.status === 'blocked' ? 'text-slate-400' : 'text-slate-700 font-medium'}`}>
                    {ai.actionName}
                  </span>
                  {ai.status === 'active' && u && <span className="text-amber-600 font-medium">{u.name} · in progress</span>}
                  {ai.status === 'completed' && <span className="text-green-600">done</span>}
                  {ai.status === 'blocked' && <span className="text-slate-300 italic">waiting</span>}
                </div>
              );
            })}
          </div>
        </div>
      ))}
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
          sub="click to see who & progress"
          color="amber"
          active={showActiveTasks}
          onClick={() => setShowActiveTasks(s => !s)}
        />
        <StatCard label="Active Sub-steps" value={totalActiveActions} sub={`${totalDoneActions} done`} color="violet" />
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
