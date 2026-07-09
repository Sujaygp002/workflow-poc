import { useState, useEffect, useRef } from 'react';
import { Activity, RefreshCw, Trash2, Clock, CalendarClock, RotateCcw } from 'lucide-react';
import {
  deleteWorkflowRun,
  fetchBusinessTime,
  fetchWorkflowRuns,
  simulateBusinessTime,
  tickTimeTriggers,
} from '../../lib/workflowApi';
import {
  RunObjectSidebar,
  triggerLabel,
  WorkflowLane,
} from '../../components/WorkflowDefinitionFlow';
import { formatUiDateTime } from '../../lib/dateFormat';

// A single workflow run rendered as the clean flowchart, with run summary.
function RunCard({ run, onDelete }) {
  const [open, setOpen] = useState(true);
  const definition = run.definition || {};
  const tasks = run.tasks || [];
  const totalManual = tasks.filter((t) => t.status === 'active' && t.actor === 'human').length;
  const totalRan = tasks.filter((t) => t.status !== 'pending' && t.status !== 'skipped').length;
  const items = run.total_items || 0;
  const hhahName = run.hhah_name || run.input_summary?.hhahName || run.input_summary?.area?.hhahName || '';

  const statusTone = run.status === 'completed'
    ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
    : run.status === 'failed'
      ? 'bg-rose-50 text-rose-700 border-rose-200'
      : 'bg-amber-50 text-amber-700 border-amber-200';

  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 p-4">
        <button onClick={() => setOpen((v) => !v)} className="text-left">
          <div className="flex items-center gap-2">
            <span className="text-base font-black text-slate-800">{definition.name || run.workflow_id}</span>
            <span className="font-mono text-[11px] text-slate-400">{run.workflow_id}</span>
          </div>
          <div className="mt-0.5 text-xs text-slate-500">
            {run.source_label || '—'} · {formatUiDateTime(run.created_at)}
          </div>
        </button>
        <div className="ml-auto flex items-center gap-2">
          <span className={`rounded-full border px-2.5 py-1 text-[11px] font-bold ${statusTone}`}>{run.status}</span>
          {hhahName && (
            <span className="rounded-full border border-sky-200 bg-sky-50 px-2.5 py-1 text-[11px] font-semibold text-sky-700">HHAH: {hhahName}</span>
          )}
          <span className="rounded-full border border-slate-200 px-2.5 py-1 text-[11px] font-semibold text-slate-600">{items} item(s)</span>
          <span className="rounded-full border border-slate-200 px-2.5 py-1 text-[11px] font-semibold text-slate-600">{totalRan} task run(s)</span>
          {totalManual > 0 && (
            <span className="rounded-full border border-pink-200 bg-pink-50 px-2.5 py-1 text-[11px] font-black text-pink-700">{totalManual} manual to do</span>
          )}
          <button
            onClick={() => onDelete(run)}
            title="Delete run"
            className="rounded-lg border border-slate-200 p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>
      {open && (
        <div className="flex flex-col gap-4 p-4 lg:flex-row lg:items-start">
          <div className="min-w-0 flex-1 overflow-x-auto">
            <WorkflowLane
              definition={definition}
              tasks={tasks}
              accent={definition.builder ? 'violet' : 'slate'}
              subtitle={`${triggerLabel(definition.trigger)} · ${items} item(s) · ${totalRan} task run(s)`}
            />
          </div>
          <RunObjectSidebar run={run} />
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, sub, color }) {
  const colors = {
    violet: 'bg-violet-50 text-violet-700 border-violet-100',
    amber: 'bg-amber-50 text-amber-700 border-amber-100',
    green: 'bg-green-50 text-green-700 border-green-100',
    slate: 'bg-slate-50 text-slate-700 border-slate-100',
    pink: 'bg-pink-50 text-pink-700 border-pink-100',
  };
  return (
    <div className={`rounded-xl border p-4 ${colors[color] || colors.slate}`}>
      <div className="text-2xl font-bold">{value}</div>
      <div className="mt-0.5 text-sm font-medium">{label}</div>
      {sub && <div className="mt-0.5 text-xs opacity-60">{sub}</div>}
    </div>
  );
}

function Legend() {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-3 text-[11px] text-slate-500">
      <span className="flex items-center gap-1"><span className="rounded bg-sky-600 px-1 py-0.5 text-[9px] font-black text-white">SYS</span> system</span>
      <span className="flex items-center gap-1"><span className="rounded bg-violet-600 px-1 py-0.5 text-[9px] font-black text-white">AI</span> Gemini</span>
      <span className="flex items-center gap-1"><span className="rounded bg-pink-600 px-1 py-0.5 text-[9px] font-black text-white">HUMAN</span> manual</span>
      <span className="flex items-center gap-1"><span className="inline-block h-3 w-3 rotate-45 border-2 border-amber-400 bg-amber-50" /> decision</span>
      <span className="flex items-center gap-1 font-mono">(n) = times the task ran</span>
      <span className="flex items-center gap-1 text-pink-700"><Clock size={11} /> N to do = manual backlog</span>
    </div>
  );
}

// Simulated business-time control (Milestone D). Shows the current simulated
// business date and lets a demo advance it (+1 day / +1 month) or reset to real
// time. The business clock drives the daily-tick fire time + day bucket, CPO /
// eligibility "today" reads, so +1 month rolls a June CPO bucket into July.
function SimTimeControl() {
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function load() {
    try {
      setState(await fetchBusinessTime());
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => { load(); }, []);

  async function apply(op) {
    if (busy) return;
    setBusy(true);
    try {
      setState(await simulateBusinessTime(op));
      setError(null);
      // After advancing the day, auto-fire the daily workflow tick
      if (op === '+1d') {
        try { await tickTimeTriggers(); } catch { /* non-fatal */ }
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const businessDate = state?.businessNow ? new Date(state.businessNow) : null;
  const label = businessDate
    ? businessDate.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
    : '—';
  const simulated = !!state?.simulated;

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2">
      <span className={`flex items-center gap-1.5 text-sm font-semibold ${simulated ? 'text-violet-700' : 'text-slate-600'}`}>
        <CalendarClock size={15} />
        Business date: {label}
      </span>
      {simulated && (
        <span className="rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-[10px] font-black uppercase tracking-wide text-violet-700">
          simulated {state.offsetDays >= 0 ? '+' : ''}{state.offsetDays}d
        </span>
      )}
      <div className="flex items-center gap-1">
        <button
          onClick={() => apply('+1d')}
          disabled={busy}
          className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
        >
          +1 day
        </button>
        <button
          onClick={() => apply('reset')}
          disabled={busy || !simulated}
          title="Reset to real time"
          className="flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-semibold text-slate-500 hover:bg-slate-50 disabled:opacity-40"
        >
          <RotateCcw size={12} /> Reset
        </button>
      </div>
      {error && <span className="text-[11px] text-rose-600">{error}</span>}
    </div>
  );
}

export default function Orchestrator() {
  const [runs, setRuns] = useState([]);
  const [dbError, setDbError] = useState(null);
  const [filter, setFilter] = useState('all');
  const [showActiveOnly, setShowActiveOnly] = useState(false);
  const [live, setLive] = useState(true);
  const [lastSync, setLastSync] = useState(null);
  const [tickError, setTickError] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const ticking = useRef(false);
  const refreshing = useRef(false);

  async function refresh() {
    // In-flight guard: skip poll ticks while a previous refresh is still pending
    // so slow responses can't stack overlapping /api/workflow-runs requests.
    if (refreshing.current) return;
    refreshing.current = true;
    try {
      const dbRuns = await fetchWorkflowRuns();
      setRuns(dbRuns);
      setDbError(null);
      setLastSync(new Date());
    } catch (err) {
      setRuns([]);
      setDbError(err.message);
    } finally {
      refreshing.current = false;
      setLoaded(true);
    }
  }

  async function handleDelete(run) {
    if (!run?.id) return;
    if (!window.confirm('Delete this workflow run?\n\nThis removes the run and its task history. Created patient/order records are kept.')) return;
    setRuns((prev) => prev.filter((r) => r.id !== run.id));
    try {
      await deleteWorkflowRun(run.id);
    } catch (err) {
      setDbError(err.message);
    }
    await refresh();
  }

  async function deleteAllRuns() {
    if (!window.confirm('Delete ALL workflow runs? This cannot be undone.')) return;
    setRuns([]);
    try {
      await fetch('/api/workflow-runs', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ all: true }) });
    } catch (err) {
      setDbError(err.message);
    }
    await refresh();
  }

  useEffect(() => { refresh(); }, []);

  // Live polling every 2.5s; pauses when the tab is hidden.
  useEffect(() => {
    if (!live) return undefined;
    const id = setInterval(() => { if (!document.hidden) refresh(); }, 2500);
    return () => clearInterval(id);
  }, [live]);

  // Fire builder time triggers (time_interval + daily_time) every 10s while the
  // Orchestrator is live so they run during demos even without the vercel cron.
  useEffect(() => {
    if (!live) return undefined;
    async function tick() {
      if (document.hidden || ticking.current) return;
      ticking.current = true;
      try {
        await tickTimeTriggers();
        setTickError(null);
        await refresh();
      } catch (err) {
        setTickError(err.message);
      } finally {
        ticking.current = false;
      }
    }
    tick();
    const id = setInterval(tick, 10000);
    return () => clearInterval(id);
  }, [live]);

  const running = runs.filter((r) => r.status === 'running');
  const completed = runs.filter((r) => r.status === 'completed');
  const manualBacklog = runs.reduce((sum, r) => sum + (r.tasks || []).filter((t) => t.status === 'active' && t.actor === 'human').length, 0);

  // All runs (the daily intake pipeline + any builder/manual runs), newest first.
  const sortDesc = (a, b) => new Date(b.created_at) - new Date(a.created_at);
  const sortedRuns = [...runs].sort(sortDesc);

  // Derive the active definition id from the newest run's workflow_id.
  const activeDefId = sortedRuns.length > 0 ? sortedRuns[0].workflow_id : null;

  const filterRun = (r) => {
    if (filter === 'running' && r.status !== 'running') return false;
    if (filter === 'completed' && r.status !== 'completed') return false;
    if (showActiveOnly && activeDefId && r.workflow_id !== activeDefId) return false;
    return true;
  };

  const allFiltered = sortedRuns.filter(filterRun);

  return (
    <div className="p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Orchestrator</h1>
          <p className="mt-1 text-sm text-slate-500">Live workflow runs rendered as flowcharts — system, AI and human tasks with decision branches.</p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <SimTimeControl />
          <button
            onClick={() => setLive((v) => !v)}
            className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors ${live ? 'border-green-300 bg-green-50 text-green-700' : 'border-slate-200 text-slate-500 hover:bg-slate-50'}`}
          >
            <span className="relative flex h-2 w-2">
              {live && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-70" />}
              <span className={`relative inline-flex h-2 w-2 rounded-full ${live ? 'bg-green-500' : 'bg-slate-400'}`} />
            </span>
            {live ? 'Live' : 'Paused'}
          </button>
          <button onClick={refresh} className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50">
            <RefreshCw size={14} /> Refresh
          </button>
        </div>
      </div>
      {lastSync && (
        <div className="-mt-4 mb-4 text-[11px] text-slate-400">{live ? 'Live · ' : ''}last updated {lastSync.toLocaleTimeString()}</div>
      )}

      {!loaded ? (
        <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {['Total Runs', 'Active', 'Completed', 'Manual Backlog'].map((label) => (
            <div key={label} className="animate-pulse rounded-xl border border-slate-100 bg-slate-50 p-4">
              <div className="h-7 w-12 rounded bg-slate-200" />
              <div className="mt-2 h-3 w-24 rounded bg-slate-200" />
              <div className="mt-2 h-2.5 w-16 rounded bg-slate-100" />
            </div>
          ))}
        </div>
      ) : (
        <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard label="Total Runs" value={runs.length} sub="all time" color="slate" />
          <StatCard label="Active" value={running.length} sub="workflows running" color="amber" />
          <StatCard label="Completed" value={completed.length} sub="workflows done" color="green" />
          <StatCard label="Manual Backlog" value={manualBacklog} sub="human tasks to do" color="pink" />
        </div>
      )}

      {dbError && (
        <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          DB workflow API unavailable: {dbError}
        </div>
      )}
      {tickError && (
        <div className="mb-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">Daily tick error: {tickError}</div>
      )}
      <Legend />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {[['all', 'All'], ['running', 'Running'], ['completed', 'Completed']].map(([v, l]) => (
          <button
            key={v}
            onClick={() => setFilter(v)}
            className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${filter === v ? 'border-violet-600 bg-violet-600 text-white' : 'border-slate-200 text-slate-500 hover:border-violet-300'}`}
          >
            {l}
          </button>
        ))}
        <button
          onClick={() => setShowActiveOnly((v) => !v)}
          className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${showActiveOnly ? 'border-sky-600 bg-sky-600 text-white' : 'border-slate-200 text-slate-500 hover:border-sky-300'}`}
        >
          Active definition only
        </button>
        <div className="ml-auto">
          <button
            onClick={deleteAllRuns}
            className="inline-flex items-center gap-1.5 rounded-lg border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-bold text-rose-600 hover:bg-rose-100"
          >
            <Trash2 size={12} />
            Clear all runs
          </button>
        </div>
      </div>

      {!loaded ? (
        <div className="py-16 text-center text-slate-400">
          <Activity size={40} className="mx-auto mb-3 animate-pulse opacity-30" />
          <p className="animate-pulse">Loading workflow runs…</p>
        </div>
      ) : allFiltered.length === 0 ? (
        <div className="py-16 text-center text-slate-400">
          <Activity size={40} className="mx-auto mb-3 opacity-30" />
          <p>No workflow runs yet. Run a builder workflow from the Workflow page&apos;s Run button, or upload documents from the HHAH portal (/hhh-login).</p>
        </div>
      ) : (
        <div>
          <div className="mb-3 flex items-center gap-2">
            <span className="rounded-full border border-sky-200 bg-sky-50 px-3 py-1 text-[11px] font-black uppercase tracking-wide text-sky-700">
              Daily Intake &amp; other runs
            </span>
            <span className="text-[11px] text-slate-400">the daily agency-intake pipeline and any builder / manual runs</span>
          </div>
          <div className="space-y-4">
            {allFiltered.map((run) => (
              <RunCard key={run.id} run={run} onDelete={handleDelete} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
