import { useState, useEffect, useRef } from 'react';
import { Activity, RefreshCw, Trash2, Clock } from 'lucide-react';
import {
  deleteWorkflowRun,
  fetchAreaIntakeStatus,
  fetchWorkflowRuns,
  runBillingMonitor,
  runAreaIntakeCheck,
} from '../../lib/workflowApi';
import {
  Connector,
  MegaGroupFlow,
  MegaTaskNode,
  RunObjectSidebar,
  triggerLabel,
  TriggerChainConnector,
  WorkflowFlow,
} from '../../components/WorkflowDefinitionFlow';
import { formatUiDateTime } from '../../lib/dateFormat';

// Area intake sub-panel shown inside the wf-area-onboarding run card.
function AreaIntakeSubPanel({ areas, loadingAreaId, onRunCheck }) {
  if (!areas.length) return null;
  return (
    <div className="mt-4 border-t border-slate-100 pt-4">
      <div className="mb-2 text-[11px] font-black uppercase tracking-wide text-slate-400">Area Intake Status</div>
      <div className="grid gap-3 lg:grid-cols-2">
        {areas.map((area) => {
          const status = area.check?.status || 'monitoring';
          const missing = area.hhahs.filter((h) => !h.received);
          const done = area.received_count === area.expected_count && area.expected_count > 0;
          const statusTone = status === 'complete' || done
            ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
            : status === 'missing_uploads'
              ? 'bg-rose-50 text-rose-700 border-rose-200'
              : 'bg-amber-50 text-amber-700 border-amber-200';
          return (
            <div key={area.id} className="rounded-xl border border-slate-200 p-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-black text-slate-800">{area.name}</div>
                  <div className="text-[11px] uppercase tracking-wide text-slate-400">{area.area_type?.replaceAll('_', ' ')}{area.state ? ` · ${area.state}` : ''}</div>
                </div>
                <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${statusTone}`}>{status.replaceAll('_', ' ')}</span>
              </div>
              <div className="mt-3 grid grid-cols-3 gap-2">
                <div className="rounded-lg bg-slate-50 px-2 py-1.5">
                  <div className="text-lg font-black text-slate-800">{area.expected_count}</div>
                  <div className="text-[10px] uppercase text-slate-400">expected</div>
                </div>
                <div className="rounded-lg bg-emerald-50 px-2 py-1.5">
                  <div className="text-lg font-black text-emerald-700">{area.received_count}</div>
                  <div className="text-[10px] uppercase text-emerald-600">received</div>
                </div>
                <div className="rounded-lg bg-rose-50 px-2 py-1.5">
                  <div className="text-lg font-black text-rose-700">{area.missing_count}</div>
                  <div className="text-[10px] uppercase text-rose-600">missing</div>
                </div>
              </div>
              <div className="mt-3 divide-y divide-slate-100 rounded-lg border border-slate-100">
                {area.hhahs.map((hhah) => (
                  <div key={hhah.hhah_id} className="flex items-center justify-between gap-2 px-3 py-2">
                    <div className="min-w-0">
                      <div className="truncate text-xs font-semibold text-slate-700">{hhah.hhah_name}</div>
                      <div className="text-[10px] text-slate-400">window {hhah.upload_window_hours || 24}h{hhah.run_count ? ` · ${hhah.run_count} run(s)` : ''}</div>
                    </div>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${hhah.received ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}`}>
                      {hhah.received ? 'received' : 'missing'}
                    </span>
                  </div>
                ))}
              </div>
              <button
                type="button"
                onClick={() => onRunCheck(area.id)}
                disabled={loadingAreaId === area.id || missing.length === 0}
                className="mt-3 inline-flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
              >
                <RefreshCw size={12} className={loadingAreaId === area.id ? 'animate-spin' : ''} />
                Simulate 24h check
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// A single workflow run rendered as the clean flowchart, with run summary.
function RunCard({ run, onDelete, areas, loadingAreaId, onRunCheck }) {
  const [open, setOpen] = useState(true);
  const definition = run.definition || {};
  const tasks = run.tasks || [];
  const totalManual = tasks.filter((t) => t.status === 'active' && t.actor === 'human').length;
  const totalRan = tasks.filter((t) => t.status !== 'pending' && t.status !== 'skipped').length;
  const items = run.total_items || 0;
  const isAreaOnboarding = run.workflow_id === 'wf-area-onboarding';

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
            <div className="mx-auto w-fit rounded-full border-2 border-slate-300 bg-slate-50 px-4 py-1 text-xs font-black text-slate-600">
              START · {triggerLabel(definition.trigger)}
            </div>
            <Connector />
            {definition.megaGroups ? (
              <MegaGroupFlow definition={definition} tasks={tasks} />
            ) : definition.megaTask ? (
              <MegaTaskNode definition={definition} tasks={tasks} megaTask={definition.megaTask} />
            ) : (
              <WorkflowFlow definition={definition} tasks={tasks} />
            )}
            <Connector />
            <div className="mx-auto mt-1 w-fit rounded-full border-2 border-slate-300 bg-slate-50 px-4 py-1 text-xs font-black text-slate-600">END</div>
            {isAreaOnboarding && areas && areas.length > 0 && (
              <AreaIntakeSubPanel areas={areas} loadingAreaId={loadingAreaId} onRunCheck={onRunCheck} />
            )}
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

export default function Orchestrator() {
  const [runs, setRuns] = useState([]);
  const [areas, setAreas] = useState([]);
  const [dbError, setDbError] = useState(null);
  const [areaError, setAreaError] = useState(null);
  const [filter, setFilter] = useState('all');
  const [live, setLive] = useState(true);
  const [lastSync, setLastSync] = useState(null);
  const [checkingAreaId, setCheckingAreaId] = useState(null);
  const [billingError, setBillingError] = useState(null);
  const billingRunning = useRef(false);

  async function refresh() {
    try {
      const [dbRuns, areaRows] = await Promise.all([
        fetchWorkflowRuns(),
        fetchAreaIntakeStatus(),
      ]);
      setRuns(dbRuns);
      setAreas(areaRows);
      setDbError(null);
      setAreaError(null);
      setLastSync(new Date());
    } catch (err) {
      setRuns([]);
      setDbError(err.message);
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

  async function handleRunAreaCheck(areaId) {
    setCheckingAreaId(areaId);
    setAreaError(null);
    try {
      await runAreaIntakeCheck({ areaId, forceExpired: true });
    } catch (err) {
      setAreaError(err.message);
    } finally {
      setCheckingAreaId(null);
      await refresh();
    }
  }

  useEffect(() => { refresh(); }, []);

  // Live polling every 2.5s; pauses when the tab is hidden.
  useEffect(() => {
    if (!live) return undefined;
    const id = setInterval(() => { if (!document.hidden) refresh(); }, 2500);
    return () => clearInterval(id);
  }, [live]);

  // Trigger 4: billing monitor every 10s while Orchestrator is live.
  useEffect(() => {
    if (!live) return undefined;
    async function tick() {
      if (document.hidden || billingRunning.current) return;
      billingRunning.current = true;
      try {
        await runBillingMonitor();
        setBillingError(null);
        await refresh();
      } catch (err) {
        setBillingError(err.message);
      } finally {
        billingRunning.current = false;
      }
    }
    tick();
    const id = setInterval(tick, 10000);
    return () => clearInterval(id);
  }, [live]);

  const running = runs.filter((r) => r.status === 'running');
  const completed = runs.filter((r) => r.status === 'completed');
  const manualBacklog = runs.reduce((sum, r) => sum + (r.tasks || []).filter((t) => t.status === 'active' && t.actor === 'human').length, 0);

  // Split runs into the three trigger-chain groups, each sorted newest-first.
  const sortDesc = (a, b) => new Date(b.created_at) - new Date(a.created_at);
  const areaRuns = runs.filter((r) => r.workflow_id === 'wf-area-onboarding').sort(sortDesc);
  const wf7Runs = runs.filter((r) => r.workflow_id === 'wf7').sort(sortDesc);
  const signingRuns = runs.filter((r) => r.workflow_id === 'wf-signing').sort(sortDesc);
  const billingRuns = runs.filter((r) => r.workflow_id === 'wf-billing-monitor').sort(sortDesc);
  const otherRuns = runs.filter((r) => !['wf-area-onboarding', 'wf7', 'wf-signing', 'wf-billing-monitor'].includes(r.workflow_id)).sort(sortDesc);

  const filterRun = (r) => (
    filter === 'running' ? r.status === 'running'
    : filter === 'completed' ? r.status === 'completed'
    : true
  );

  const runCardProps = { onDelete: handleDelete, areas, loadingAreaId: checkingAreaId, onRunCheck: handleRunAreaCheck };

  // Flatten filtered runs for simple "All" count chips.
  const allFiltered = [...areaRuns, ...wf7Runs, ...signingRuns, ...billingRuns, ...otherRuns].filter(filterRun);

  return (
    <div className="p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Orchestrator</h1>
          <p className="mt-1 text-sm text-slate-500">Live workflow runs rendered as flowcharts — system, AI and human tasks with decision branches.</p>
        </div>
        <div className="flex items-center gap-2">
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

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Total Runs" value={runs.length} sub="all time" color="slate" />
        <StatCard label="Active" value={running.length} sub="workflows running" color="amber" />
        <StatCard label="Completed" value={completed.length} sub="workflows done" color="green" />
        <StatCard label="Manual Backlog" value={manualBacklog} sub="human tasks to do" color="pink" />
      </div>

      {dbError && (
        <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          DB workflow API unavailable: {dbError}
        </div>
      )}
      {areaError && (
        <div className="mb-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">Area intake error: {areaError}</div>
      )}
      {billingError && (
        <div className="mb-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">Trigger 4 error: {billingError}</div>
      )}
      <Legend />

      <div className="mb-4 flex gap-2">
        {[['all', 'All'], ['running', 'Running'], ['completed', 'Completed']].map(([v, l]) => (
          <button
            key={v}
            onClick={() => setFilter(v)}
            className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${filter === v ? 'border-violet-600 bg-violet-600 text-white' : 'border-slate-200 text-slate-500 hover:border-violet-300'}`}
          >
            {l}
          </button>
        ))}
      </div>

      {allFiltered.length === 0 ? (
        <div className="py-16 text-center text-slate-400">
          <Activity size={40} className="mx-auto mb-3 opacity-30" />
          <p>No workflow runs yet. Fire a trigger from the Triggers page.</p>
        </div>
      ) : (
        <div>
          {/* ── Trigger 1: Area Onboarding & Monitor ── */}
          {areaRuns.filter(filterRun).map((run) => (
            <RunCard key={run.id} run={run} {...runCardProps} />
          ))}

          {/* ── Trigger 2: HHAH Uploads Documents (wf7) — independent, not chained from Trigger 1 ── */}
          {wf7Runs.filter(filterRun).length > 0 && (
            <div className="mt-8">
              <div className="mb-3 flex items-center gap-2">
                <span className="rounded-full border border-sky-200 bg-sky-50 px-3 py-1 text-[11px] font-black uppercase tracking-wide text-sky-700">
                  Trigger 2 · HHAH Uploads Documents
                </span>
                <span className="text-[11px] text-slate-400">fires independently when an HHAH uploads</span>
              </div>
              <div className="space-y-4">
                {wf7Runs.filter(filterRun).map((run) => (
                  <RunCard key={run.id} run={run} {...runCardProps} />
                ))}
              </div>
            </div>
          )}

          {/* ── Trigger 3: Send To Physician ── */}
          {signingRuns.filter(filterRun).length > 0 && (
            <>
              <TriggerChainConnector triggerNum={3} label="Send To Physician" />
              <div className="space-y-4">
                {signingRuns.filter(filterRun).map((run) => (
                  <RunCard key={run.id} run={run} {...runCardProps} />
                ))}
              </div>
            </>
          )}

          {/* ── Trigger 4: Make Patients Billable ── */}
          {billingRuns.filter(filterRun).length > 0 && (
            <div className="mt-8">
              <div className="mb-3 flex items-center gap-2">
                <span className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-[11px] font-black uppercase tracking-wide text-amber-700">
                  Trigger 4 · Make Patients Billable
                </span>
                <span className="text-[11px] text-slate-400">runs independently every 10 seconds</span>
              </div>
              <div className="space-y-4">
                {billingRuns.filter(filterRun).map((run) => (
                  <RunCard key={run.id} run={run} {...runCardProps} />
                ))}
              </div>
            </div>
          )}

          {/* ── Other runs (not in the main chain) ── */}
          {otherRuns.filter(filterRun).length > 0 && (
            <div className="mt-4 space-y-4">
              {otherRuns.filter(filterRun).map((run) => (
                <RunCard key={run.id} run={run} {...runCardProps} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
