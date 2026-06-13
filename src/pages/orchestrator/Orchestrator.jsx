import { useState, useEffect } from 'react';
import { Activity, CheckCircle2, Circle, AlertCircle, RefreshCw, Trash2, ArrowDown, Bot, Cog, User, Clock, Info } from 'lucide-react';
import {
  deleteWorkflowRun,
  fetchAreaIntakeStatus,
  fetchWorkflowRuns,
  runAreaIntakeCheck,
} from '../../lib/workflowApi';

// ── Actor styling ──────────────────────────────────────────
// system = sky/blue, AI = violet, human = pink, condition = amber.
const ACTOR = {
  system: { ring: 'border-sky-300', bg: 'bg-sky-50', text: 'text-sky-800', badge: 'bg-sky-600', label: 'SYS', icon: Cog },
  ai: { ring: 'border-violet-300', bg: 'bg-violet-50', text: 'text-violet-800', badge: 'bg-violet-600', label: 'AI', icon: Bot },
  human: { ring: 'border-pink-300', bg: 'bg-pink-50', text: 'text-pink-800', badge: 'bg-pink-600', label: 'HUMAN', icon: User },
};

function actorOf(step) {
  return ACTOR[step.actor] || ACTOR.system;
}

// Per-step run aggregation, derived from the run's task rows (one per item×step).
// Returns: total (how many times the task ran), done, active, manual (active human
// tasks = the stuck backlog needing manual work).
function stepStats(tasks, stepId) {
  const rows = tasks.filter((t) => t.step_id === stepId);
  const done = rows.filter((t) => t.status === 'completed').length;
  const active = rows.filter((t) => t.status === 'active').length;
  const failed = rows.filter((t) => t.status === 'failed').length;
  const ran = rows.filter((t) => t.status !== 'pending' && t.status !== 'skipped').length;
  return { total: rows.length, ran, done, active, failed };
}

// Decide a step's live state across all items for the node tint.
function nodeState(stats) {
  if (stats.failed) return 'failed';
  if (stats.active) return 'active';
  if (stats.done) return 'done';
  return 'idle';
}

const STATE_DOT = {
  failed: <AlertCircle size={13} className="text-rose-500" />,
  active: <Circle size={13} className="text-amber-500 fill-amber-200" />,
  done: <CheckCircle2 size={13} className="text-emerald-500" />,
  idle: <Circle size={13} className="text-slate-300" />,
};

// Derive the YES/NO branch truth for a condition (mirrors CLAUDE.md rules):
// for *_missing / *_not_exists / *_fail conditions the YES arm is the exception
// path, so the diamond reads naturally.
function conditionLabel(condition) {
  return (condition || '').replaceAll('_', ' ');
}

// A decision diamond: the condition sits in a rotated square. The down exit is the
// branch's own truth (YES when the gated step runs); the right exit is the
// complement, labelled with the sibling outcome when known.
function DecisionDiamond({ condition, downLabel = 'YES', rightLabel }) {
  return (
    <div className="relative flex flex-col items-center my-1">
      <div className="relative h-20 w-44 flex items-center justify-center">
        <div className="absolute h-16 w-16 rotate-45 border-2 border-amber-400 bg-amber-50 rounded-sm" />
        <span className="relative z-10 px-2 text-center text-[10px] font-bold leading-tight text-amber-800">
          {conditionLabel(condition)}?
        </span>
        {rightLabel && (
          <div className="absolute left-full top-1/2 flex items-center gap-1 -translate-y-1/2 pl-1">
            <span className="text-[10px] font-black text-slate-400">→ {rightLabel}</span>
          </div>
        )}
      </div>
      <span className="text-[10px] font-black text-emerald-600">{downLabel} ↓</span>
    </div>
  );
}

// ⓘ popover with the step's full definition.
function StepInfo({ step }) {
  const [open, setOpen] = useState(false);
  const a = actorOf(step);
  return (
    <span className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-5 w-5 items-center justify-center rounded-full text-slate-400 hover:bg-white/70 hover:text-slate-600"
        title="Task definition"
      >
        <Info size={13} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-6 z-40 w-72 rounded-xl border border-slate-200 bg-white p-3 text-left shadow-xl">
            <div className="flex items-center gap-2">
              <span className="font-mono text-[10px] text-slate-400">{step.id}</span>
              <span className={`rounded ${a.badge} px-1 py-0.5 text-[9px] font-black uppercase text-white`}>{a.label}</span>
              <span className="font-mono text-[10px] text-slate-400">{step.taskKey}</span>
            </div>
            <div className="mt-1 text-sm font-bold text-slate-800">{step.name}</div>
            {step.description && <div className="mt-1 text-[11px] leading-snug text-slate-600">{step.description}</div>}
            {step.condition && (
              <div className="mt-2 rounded-lg border border-amber-100 bg-amber-50 px-2 py-1">
                <div className="text-[9px] font-black uppercase text-amber-600">Runs when</div>
                <div className="font-mono text-[10px] text-amber-800">{step.condition}</div>
              </div>
            )}
          </div>
        </>
      )}
    </span>
  );
}

// One task node in the flowchart.
function StepNode({ step, stats }) {
  const a = actorOf(step);
  const Icon = a.icon;
  const state = nodeState(stats);
  const manual = step.actor === 'human' ? stats.active : 0;
  return (
    <div className={`relative w-[24rem] max-w-full rounded-xl border-2 ${a.ring} ${a.bg} px-3 py-2 shadow-sm`}>
      <div className="flex items-start gap-2">
        <span className={`mt-0.5 shrink-0 rounded-md ${a.badge} px-1.5 py-0.5 text-[9px] font-black uppercase text-white`}>{a.label}</span>
        <Icon size={14} className={`mt-0.5 shrink-0 ${a.text}`} />
        <span className={`text-sm font-bold leading-tight break-words ${a.text}`}>{step.name}</span>
        {/* run-count in () next to the task */}
        <span className="ml-auto flex shrink-0 items-center gap-1 text-[11px] font-mono text-slate-500">
          {STATE_DOT[state]}
          <span title="times this task has run">({stats.ran})</span>
          <StepInfo step={step} />
        </span>
      </div>
      <div className="mt-1 flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] text-slate-400">{step.id}</span>
        <div className="flex items-center gap-1.5">
          {stats.done > 0 && <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700">{stats.done} done</span>}
          {/* manual backlog: active human tasks still needing a person */}
          {manual > 0 && (
            <span className="flex items-center gap-1 rounded bg-pink-100 px-1.5 py-0.5 text-[10px] font-black text-pink-700">
              <Clock size={10} /> {manual} to do
            </span>
          )}
          {stats.failed > 0 && <span className="rounded bg-rose-100 px-1.5 py-0.5 text-[10px] font-bold text-rose-700">{stats.failed} failed</span>}
        </div>
      </div>
    </div>
  );
}

function Connector() {
  return <ArrowDown size={16} className="my-0.5 text-slate-300" />;
}

// Render a whole workflow definition as a vertical flowchart with decision
// diamonds. Conditional steps get a diamond above them; consecutive steps that
// share the same preReq + are mutually-exclusive branches render as sibling arms.
function WorkflowFlow({ definition, tasks }) {
  const steps = definition.steps || [];
  const rendered = [];

  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    const stats = stepStats(tasks, step.id);

    // A conditional step gets a decision diamond. If the *next* step is a
    // mutually-exclusive sibling (same preReq, also conditional), pair them so
    // the diamond shows both outcomes.
    const next = steps[i + 1];
    const isPair = step.condition && next?.condition
      && JSON.stringify(step.preReq) === JSON.stringify(next.preReq);

    if (isPair) {
      const nextStats = stepStats(tasks, next.id);
      rendered.push(
        <div key={step.id} className="flex flex-col items-center">
          {rendered.length > 0 && <Connector />}
          <DecisionDiamond condition={step.condition} downLabel="YES" rightLabel="else →" />
          <div className="flex w-full items-start justify-center gap-4">
            <div className="flex flex-col items-center">
              <span className="mb-1 text-[10px] font-black text-emerald-600">{conditionLabel(step.condition)}</span>
              <StepNode step={step} stats={stats} />
            </div>
            <div className="flex flex-col items-center">
              <span className="mb-1 text-[10px] font-black text-slate-500">{conditionLabel(next.condition)}</span>
              <StepNode step={next} stats={nextStats} />
            </div>
          </div>
        </div>,
      );
      i += 1; // consumed the sibling
      continue;
    }

    rendered.push(
      <div key={step.id} className="flex flex-col items-center">
        {rendered.length > 0 && <Connector />}
        {step.condition && <DecisionDiamond condition={step.condition} downLabel="YES" />}
        <StepNode step={step} stats={stats} />
      </div>,
    );
  }

  return <div className="flex flex-col items-center py-2">{rendered}</div>;
}

// A single workflow run rendered as the clean flowchart, with run summary.
function RunCard({ run, onDelete }) {
  const [open, setOpen] = useState(true);
  const definition = run.definition || {};
  const tasks = run.tasks || [];
  const totalManual = tasks.filter((t) => t.status === 'active' && t.actor === 'human').length;
  const totalRan = tasks.filter((t) => t.status !== 'pending' && t.status !== 'skipped').length;
  const items = run.total_items || 0;

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
            {run.source_label || '—'} · {new Date(run.created_at).toLocaleString()}
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
        <div className="overflow-x-auto p-4">
          <div className="mx-auto w-fit rounded-full border-2 border-slate-300 bg-slate-50 px-4 py-1 text-xs font-black text-slate-600">
            START · {definition.trigger?.id || 'trigger'}
          </div>
          <Connector />
          <WorkflowFlow definition={definition} tasks={tasks} />
          <div className="mx-auto mt-1 w-fit rounded-full border-2 border-slate-300 bg-slate-50 px-4 py-1 text-xs font-black text-slate-600">END</div>
        </div>
      )}
    </div>
  );
}

// ── Area intake monitor (Trigger 1) ────────────────────────
function AreaIntakePanel({ areas, loadingAreaId, onRunCheck }) {
  if (!areas.length) {
    return (
      <section className="mb-5 rounded-2xl border border-slate-200 bg-white p-4">
        <div className="text-sm font-semibold text-slate-700">Area intake monitor</div>
        <div className="mt-1 text-sm text-slate-400">No statistical areas have been seeded yet.</div>
      </section>
    );
  }
  return (
    <section className="mb-5 rounded-2xl border border-slate-200 bg-white p-4">
      <div>
        <h2 className="text-sm font-bold text-slate-800">Area Intake Monitor · Trigger 1</h2>
        <p className="mt-1 text-xs text-slate-500">Onboarding starts the daily monitor. Upload and missing-upload notification triggers run independently.</p>
      </div>
      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        {areas.map((area) => {
          const status = area.check?.status || 'monitoring';
          const missing = area.hhahs.filter((hhah) => !hhah.received);
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
                  <div className="text-[11px] uppercase tracking-wide text-slate-400">{area.area_type?.replaceAll('_', ' ')} {area.state ? `· ${area.state}` : ''}</div>
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
                      <div className="text-[10px] text-slate-400">window {hhah.upload_window_hours || 24}h {hhah.run_count ? `· ${hhah.run_count} run(s)` : ''}</div>
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
    </section>
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

  const running = runs.filter((r) => r.status === 'running');
  const completed = runs.filter((r) => r.status === 'completed');
  const manualBacklog = runs.reduce((sum, r) => sum + (r.tasks || []).filter((t) => t.status === 'active' && t.actor === 'human').length, 0);

  const filtered = runs
    .filter((r) => (filter === 'running' ? r.status === 'running' : filter === 'completed' ? r.status === 'completed' : true))
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

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

      <AreaIntakePanel areas={areas} loadingAreaId={checkingAreaId} onRunCheck={handleRunAreaCheck} />

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

      {filtered.length === 0 ? (
        <div className="py-16 text-center text-slate-400">
          <Activity size={40} className="mx-auto mb-3 opacity-30" />
          <p>No workflow runs yet. Fire a trigger from the Triggers page.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {filtered.map((run) => <RunCard key={run.id} run={run} onDelete={handleDelete} />)}
        </div>
      )}
    </div>
  );
}
