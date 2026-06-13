// Shared flowchart renderer for workflow definitions.
// Used by the Workflows page (static, tasks=[]) and the Orchestrator (live, tasks=run.tasks).
//
// Renders the DB step schema:
//   { id, name, actor, taskKey, condition, preReq, description }
// as a vertical top-down flowchart with decision diamonds, actor-coloured boxes,
// and ⓘ info popovers.
import { useState } from 'react';
import { ArrowDown, Bot, Cog, User, Clock, Info, CheckCircle2, Circle, AlertCircle } from 'lucide-react';

// ── Actor styling ─────────────────────────────────────
// system = sky/blue, AI = violet, human = pink
export const ACTOR = {
  system: { ring: 'border-sky-300', bg: 'bg-sky-50', text: 'text-sky-800', badge: 'bg-sky-600', label: 'SYS', icon: Cog },
  ai:     { ring: 'border-violet-300', bg: 'bg-violet-50', text: 'text-violet-800', badge: 'bg-violet-600', label: 'AI', icon: Bot },
  human:  { ring: 'border-pink-300', bg: 'bg-pink-50', text: 'text-pink-800', badge: 'bg-pink-600', label: 'HUMAN', icon: User },
};

export function actorOf(step) {
  return ACTOR[step.actor] || ACTOR.system;
}

// Live stats from task run rows (pass [] for static/definition view).
export function stepStats(tasks, stepId) {
  const rows = tasks.filter((t) => t.step_id === stepId);
  const done   = rows.filter((t) => t.status === 'completed').length;
  const active = rows.filter((t) => t.status === 'active').length;
  const failed = rows.filter((t) => t.status === 'failed').length;
  const ran    = rows.filter((t) => t.status !== 'pending' && t.status !== 'skipped').length;
  return { total: rows.length, ran, done, active, failed };
}

function nodeState(stats) {
  if (stats.failed) return 'failed';
  if (stats.active) return 'active';
  if (stats.done)   return 'done';
  return 'idle';
}

const STATE_DOT = {
  failed: <AlertCircle size={13} className="text-rose-500" />,
  active: <Circle      size={13} className="text-amber-500 fill-amber-200" />,
  done:   <CheckCircle2 size={13} className="text-emerald-500" />,
  idle:   <Circle      size={13} className="text-slate-300" />,
};

export function conditionLabel(condition) {
  return (condition || '').replaceAll('_', ' ');
}

// ── Decision diamond ──────────────────────────────────
// The condition sits in a rotated square. Down exit = YES; right exit = else branch.
export function DecisionDiamond({ condition, downLabel = 'YES', rightLabel }) {
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

// ── ⓘ info popover ───────────────────────────────────
export function StepInfo({ step }) {
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

// ── Task node box ─────────────────────────────────────
export function StepNode({ step, stats }) {
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

export function Connector() {
  return <ArrowDown size={16} className="my-0.5 text-slate-300" />;
}

// ── Main flowchart renderer ───────────────────────────
// Renders a workflow definition's steps as a vertical flowchart.
// Conditional steps get a decision diamond; adjacent mutual-exclusive siblings
// (same preReq + both conditional) render side-by-side under one diamond.
// `tasks` is an array of task-run rows for live stats; pass [] for static view.
export function WorkflowFlow({ definition, tasks = [] }) {
  const steps = definition.steps || [];
  const rendered = [];

  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    const stats = stepStats(tasks, step.id);
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
      i += 1;
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

// ── "after end →" chain connector between trigger-chain workflows ──
export function TriggerChainConnector({ triggerNum, label }) {
  return (
    <div className="flex flex-col items-center py-1">
      <div className="h-6 w-0.5 bg-slate-300" />
      <div className="flex items-center gap-2 rounded-full border-2 border-violet-400 bg-violet-50 px-4 py-1">
        <span className="text-[10px] font-black uppercase tracking-wide text-violet-500">after end</span>
        <span className="text-[10px] font-black text-slate-400">→</span>
        <span className="text-[11px] font-black text-violet-700">Trigger {triggerNum} · {label}</span>
      </div>
      <div className="h-6 w-0.5 bg-slate-300" />
    </div>
  );
}
