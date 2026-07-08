// Shared flowchart renderer for workflow definitions.
// Used by the Workflows page (static, tasks=[]) and the Orchestrator (live, tasks=run.tasks).
//
// Renders the DB step schema:
//   { id, name, actor, taskKey, condition, preReq, description }
// as a vertical top-down flowchart with decision diamonds, actor-coloured boxes,
// and ⓘ info popovers.
import { Fragment, useState } from 'react';
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

// Label for the START cap. Time-interval triggers read as "Time trigger · every Ns";
// daily_time triggers read as the per-agency fan-out ("For each onboarded agency …").
export function triggerLabel(trigger) {
  if (!trigger) return 'trigger';
  if (trigger.type === 'time_interval' && trigger.intervalSeconds) {
    return trigger.label || `Time trigger · every ${trigger.intervalSeconds}s`;
  }
  if (trigger.type === 'daily_time') {
    return trigger.label || 'For each onboarded agency · check if uploaded';
  }
  return trigger.label || trigger.id || trigger.type || 'trigger';
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
// A human step's inline "who does this" label. `assignee` is an optional
// {display_name|username} lookup so the manual task reads as a node IN the flow
// (an employee acts here) rather than a detached bucket tile elsewhere.
function assigneeLabel(step, assignee) {
  if (step.actor !== 'human') return null;
  const who = assignee?.display_name || assignee?.username;
  if (who) return `Assigned to ${who}`;
  const n = Array.isArray(step.actions) ? step.actions.length : 0;
  return n > 1 ? `Employee task · ${n} actions` : 'Employee task';
}

export function StepNode({ step, stats, assignee }) {
  const a = actorOf(step);
  const Icon = a.icon;
  const state = nodeState(stats);
  const manual = step.actor === 'human' ? stats.active : 0;
  const who = assigneeLabel(step, assignee);
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
      {who && (
        <div className="mt-1 flex items-center gap-1 text-[11px] font-semibold text-pink-700">
          <User size={11} /> {who}
        </div>
      )}
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
// `steps` overrides definition.steps (used to render a mega-group's subset).
export function WorkflowFlow({ definition, tasks = [], steps: stepsOverride, employeesById = {} }) {
  const steps = stepsOverride || definition.steps || [];
  const rendered = [];
  const who = (step) => employeesById[step.assigneeEmployeeId] || null;

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
              <StepNode step={step} stats={stats} assignee={who(step)} />
            </div>
            <div className="flex flex-col items-center">
              <span className="mb-1 text-[10px] font-black text-slate-500">{conditionLabel(next.condition)}</span>
              <StepNode step={next} stats={nextStats} assignee={who(next)} />
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
        <StepNode step={step} stats={stats} assignee={who(step)} />
      </div>,
    );
  }

  return <div className="flex flex-col items-center py-2">{rendered}</div>;
}

// ── Cohesive workflow lane ────────────────────────────
// Wraps a whole workflow (START · trigger → steps → END) in ONE titled card so it
// reads as a single cohesive workflow, not a loose pile of task boxes. Picks the
// right inner renderer (megaGroups / megaTask / plain flow) automatically, so
// builder workflows (plain steps[]) get the same "one workflow" framing the
// grouped system workflows have. `employeesById` maps assigneeEmployeeId → employee.
export function WorkflowLane({ definition, tasks = [], employeesById = {}, subtitle, accent = 'violet' }) {
  const steps = definition.steps || [];
  const humanCount = steps.filter((s) => s.actor === 'human').length;
  const tone = {
    violet: 'border-violet-200',
    sky: 'border-sky-200',
    slate: 'border-slate-200',
  }[accent] || 'border-slate-200';

  let inner;
  if (definition.megaGroups) inner = <MegaGroupFlow definition={definition} tasks={tasks} employeesById={employeesById} />;
  else if (definition.megaTask) inner = <MegaTaskNode definition={definition} tasks={tasks} megaTask={definition.megaTask} />;
  else inner = <WorkflowFlow definition={definition} tasks={tasks} employeesById={employeesById} />;

  return (
    <div className={`rounded-2xl border-2 ${tone} bg-white/60 p-4`}>
      <div className="mb-2 text-center">
        <div className="text-sm font-black uppercase tracking-wide text-slate-700">{definition.name || definition.id}</div>
        <div className="mt-0.5 text-[11px] text-slate-400">
          {subtitle
            || `${triggerLabel(definition.trigger)} · ${steps.length} step${steps.length === 1 ? '' : 's'}${humanCount ? ` · ${humanCount} human task${humanCount === 1 ? '' : 's'}` : ''}`}
        </div>
      </div>
      <div className="flex flex-col items-center">
        <div className="w-fit rounded-full border-2 border-slate-300 bg-slate-50 px-4 py-1 text-xs font-black text-slate-600">
          START · {triggerLabel(definition.trigger)}
        </div>
        <Connector />
        {inner}
        <Connector />
        <div className="mt-1 w-fit rounded-full border-2 border-slate-300 bg-slate-50 px-4 py-1 text-xs font-black text-slate-600">END</div>
      </div>
    </div>
  );
}

// ── Mega-task node ────────────────────────────────────
// Collapses a set of steps into ONE box (e.g. "HHAH Upload Monitor",
// "Updating Patient Object"). Shows: name, (n) inner-run count, ⓘ info popover,
// and a "View" button that expands the inner sub-task flowchart below the box.
//
// Accepts either a `megaTask` ({name, info}) for whole-definition collapse, or
// explicit `name`/`info`/`steps` for a single group within a multi-group workflow.
export function MegaTaskNode({ definition, tasks = [], megaTask, name, info, steps }) {
  const [open, setOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);

  const allSteps = definition.steps || [];
  const stepsById = Object.fromEntries(allSteps.map((s) => [s.id, s]));
  // Inner steps: explicit `steps` prop (mega-group) > megaTask.innerStepIds > all steps.
  const innerSteps = steps
    || (megaTask?.innerStepIds
      ? megaTask.innerStepIds.map((id) => stepsById[id]).filter(Boolean)
      : allSteps);
  // Optional steps pulled OUT of the box, rendered after it (each with a decision
  // diamond from its condition).
  const outsideSteps = (megaTask?.outsideStepIds || [])
    .map((id) => stepsById[id])
    .filter(Boolean);
  const rawName = name || megaTask?.name || definition.name;
  // Mega-task boxes are prefixed "TASK-" to read as a single collapsed task.
  const boxName = `TASK-${rawName}`;
  const boxInfo = info || megaTask?.info || definition.description;
  const innerIds = new Set(innerSteps.map((s) => s.id));
  // (n) = number of distinct items (instances) this task processed — e.g. one per
  // expected HHAH for the monitor, one per patient/order row for wf7. Counts items
  // that have at least one ran (non-pending, non-skipped) step inside this group.
  const ran = new Set(
    tasks
      .filter((t) => innerIds.has(t.step_id) && t.status !== 'pending' && t.status !== 'skipped')
      .map((t) => t.item_id ?? t.item_index),
  ).size;
  const a = ACTOR.system;
  const Icon = a.icon;
  return (
    <div className="flex w-full flex-col items-center">
      <div className={`relative w-[26rem] max-w-full rounded-xl border-2 ${a.ring} ${a.bg} px-3 py-3 shadow-sm`}>
        <div className="flex items-start gap-2">
          <span className={`mt-0.5 shrink-0 rounded-md ${a.badge} px-1.5 py-0.5 text-[9px] font-black uppercase text-white`}>{a.label}</span>
          <Icon size={15} className={`mt-0.5 shrink-0 ${a.text}`} />
          <span className={`text-sm font-black leading-tight ${a.text}`}>{boxName}</span>
          <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[11px] font-mono text-slate-500">
            <span title="instances (items) this task processed">({ran})</span>
            <span className="relative">
              <button
                type="button"
                onClick={() => setInfoOpen((v) => !v)}
                className="flex h-5 w-5 items-center justify-center rounded-full text-slate-400 hover:bg-white/70 hover:text-slate-600"
                title="What this task does"
              >
                <Info size={14} />
              </button>
              {infoOpen && (
                <>
                  <div className="fixed inset-0 z-30" onClick={() => setInfoOpen(false)} />
                  <div className="absolute right-0 top-6 z-40 w-72 rounded-xl border border-slate-200 bg-white p-3 text-left shadow-xl">
                    <div className="text-sm font-bold text-slate-800">{boxName}</div>
                    <div className="mt-1 text-[11px] leading-snug text-slate-600">{boxInfo}</div>
                  </div>
                </>
              )}
            </span>
          </span>
        </div>
        <div className="mt-2 flex justify-center">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className={`flex items-center gap-1.5 rounded-lg border px-3 py-1 text-xs font-bold transition-colors ${open ? 'border-sky-400 bg-sky-600 text-white' : 'border-sky-200 bg-white text-sky-700 hover:bg-sky-50'}`}
          >
            {open ? 'Hide tasks' : 'View'} {open ? '▲' : '▼'}
          </button>
        </div>
      </div>
      {open && (
        <div className="mt-2 w-full rounded-2xl border-2 border-dashed border-sky-200 bg-sky-50/40 p-3">
          <div className="mb-1 text-center text-[10px] font-black uppercase tracking-wide text-sky-400">
            Inside {boxName}
          </div>
          <WorkflowFlow definition={definition} tasks={tasks} steps={innerSteps} />
        </div>
      )}
      {/* Steps pulled OUTSIDE the box: each gated by a decision diamond from its condition. */}
      {outsideSteps.map((step) => (
        <div key={step.id} className="flex w-full flex-col items-center">
          <Connector />
          {step.condition && <DecisionDiamond condition={step.condition} downLabel="YES" />}
          <StepNode step={step} stats={stepStats(tasks, step.id)} />
        </div>
      ))}
    </div>
  );
}

// ── Mega-group flow ───────────────────────────────────
// Renders a workflow whose steps are partitioned into `megaGroups`. Grouped steps
// collapse into MegaTaskNode boxes; steps that belong to NO group render FLAT (via
// WorkflowFlow, so their decision diamonds show OUTSIDE the boxes) in their compiled
// position, interleaved with the group boxes. This is what lets phase-1 read as
// START → n1 (flat) → agency diamond (OUTSIDE both boxes) → the two TASK boxes as
// the two branch outcomes. wf7 has every step grouped and no branching between its
// two boxes, so it renders as the same box → connector → box chain as before.
function groupBox(definition, tasks, group, stepsById, branchLabel) {
  const steps = (group.stepIds || []).map((id) => stepsById[id]).filter(Boolean);
  return (
    <div className="flex flex-col items-center">
      {branchLabel && <span className="mb-1 text-[10px] font-black text-emerald-600">{branchLabel}</span>}
      <MegaTaskNode definition={definition} tasks={tasks} name={group.name} info={group.info} steps={steps} />
    </div>
  );
}

export function MegaGroupFlow({ definition, tasks = [], employeesById = {} }) {
  const groups = definition.megaGroups || [];
  const allSteps = definition.steps || [];
  const stepsById = Object.fromEntries(allSteps.map((s) => [s.id, s]));
  // Map each step id → the group it belongs to (first group wins on overlap).
  const groupOfStep = new Map();
  for (const group of groups) {
    for (const id of group.stepIds || []) {
      if (!groupOfStep.has(id)) groupOfStep.set(id, group);
    }
  }
  // The step that leads a group (its first member in compiled order) — its
  // `condition`/`preReq` decide whether the group is a branch arm of a diamond.
  const leadStep = (group) => stepsById[(group.stepIds || [])[0]];

  // Walk steps in compiled order, batching contiguous ungrouped steps into flat
  // spans and emitting each group box once (at the position of its first member).
  const rendered = [];
  const emittedGroups = new Set();
  let flatSpan = [];
  const flushFlat = () => {
    if (!flatSpan.length) return;
    const span = flatSpan;
    flatSpan = [];
    rendered.push({ kind: 'flat', key: `flat-${span[0].id}`, steps: span });
  };
  for (const step of allSteps) {
    const group = groupOfStep.get(step.id);
    if (!group) { flatSpan.push(step); continue; }
    flushFlat();
    if (emittedGroups.has(group.id)) continue;
    emittedGroups.add(group.id);
    rendered.push({ kind: 'group', key: group.id, group });
  }
  flushFlat();

  // Pass 2: two adjacent group boxes whose lead steps carry a `condition` and
  // share the same `preReq` are the two arms of ONE decision diamond — render the
  // diamond OUTSIDE both boxes, boxes side-by-side (mirrors WorkflowFlow pairing).
  const out = [];
  for (let i = 0; i < rendered.length; i += 1) {
    const entry = rendered[i];
    const next = rendered[i + 1];
    if (entry.kind === 'group' && next?.kind === 'group') {
      const a = leadStep(entry.group);
      const b = leadStep(next.group);
      const pair = a?.condition && b?.condition
        && JSON.stringify(a.preReq) === JSON.stringify(b.preReq);
      if (pair) {
        out.push(
          <div key={entry.key} className="flex w-full flex-col items-center">
            {out.length > 0 && <Connector />}
            <DecisionDiamond condition={a.condition} downLabel="YES" rightLabel="else →" />
            <div className="flex w-full items-start justify-center gap-4">
              {groupBox(definition, tasks, entry.group, stepsById, conditionLabel(a.condition))}
              {groupBox(definition, tasks, next.group, stepsById, conditionLabel(b.condition))}
            </div>
          </div>,
        );
        i += 1; // consumed `next`
        continue;
      }
    }
    out.push(
      <div key={entry.key} className="flex w-full flex-col items-center">
        {out.length > 0 && <Connector />}
        {entry.kind === 'group'
          ? (() => {
            const a = leadStep(entry.group);
            // A lone group whose lead step is conditional gets its own diamond.
            return (
              <>
                {a?.condition && <DecisionDiamond condition={a.condition} downLabel="YES" />}
                {groupBox(definition, tasks, entry.group, stepsById, null)}
              </>
            );
          })()
          : <WorkflowFlow definition={definition} tasks={tasks} steps={entry.steps} employeesById={employeesById} />}
      </div>,
    );
  }

  return <div className="flex w-full flex-col items-center">{out}</div>;
}

// ── Per-object created/updated/existing aggregation ───
// Reduces a run's task rows (each carries the item's `decisions`) into per-object
// counts. One vote per distinct item (item_index). Mirrors WorkBucket lifecycle.
//
// Returns ordered rows of { object, created, updated, existed } per workflow type.
function classifyObject(object, d = {}) {
  switch (object) {
    case 'Patient Unit':
      if (d.unit_not_exists || (d.patient_not_exists && (d.patient_write_success || d.patient_retry_success))) return 'created';
      // An existing unit that a successful patient write touched counts as
      // updated (the daily intake's patient.update path never stamps
      // unit_only_changed — that was the wf7 record.checkChanges fork).
      if (d.unit_exists || d.patient_exists) {
        return (d.unit_only_changed || d.patient_write_success || d.patient_retry_success) ? 'updated' : 'existed';
      }
      return null;
    case 'Patient Record':
      if (d.record_created || d.patient_not_exists) return 'created';
      if (d.record_context_changed) return 'created';
      if (d.record_updated || d.unit_only_changed) return 'updated';
      if (d.patient_exists) return 'existed';
      return null;
    case 'Admission Object':
      if (d.admission_created) return 'created';
      if (d.admission_exists) return 'existed';
      if (d.admission_ready) return 'created';
      return null;
    case 'Episode Object':
      if (d.episode_created) return 'created';
      if (d.episode_exists) return 'existed';
      if (d.episode_ready) return 'created';
      return null;
    case 'Order':
      if (d.order_write_success || d.order_retry_success) return 'created';
      if (d.order_skipped_duplicate || d.order_exists) return 'existed';
      return null;
    default:
      return null;
  }
}

// Object rows for a run, derived from the task keys the run actually carries —
// so builder workflows (e.g. the daily intake pipeline) get the right rows
// without a per-workflow-id map. Contact-only items contribute nothing (their
// decisions carry no object flags).
function objectsForRun(run) {
  const keys = new Set((run.tasks || []).map((t) => t.task_key).filter(Boolean));
  const has = (prefix) => [...keys].some((key) => key.startsWith(prefix));
  const objects = [];
  if (has('patient.') || has('record.')) objects.push('Patient Unit', 'Patient Record');
  if (has('admission.')) objects.push('Admission Object');
  if (has('episode.')) objects.push('Episode Object');
  if (has('order.')) objects.push('Order');
  return objects;
}

// `existedLabel` distinguishes the pre-trigger "already exist" column wording.
export function runObjectStats(run) {
  const objects = objectsForRun(run);
  if (!objects.length) return null;
  const tasks = run.tasks || [];
  // Collapse to one decisions object per distinct item.
  const byItem = new Map();
  for (const t of tasks) {
    if (t.item_index === undefined || t.item_index === null) continue;
    if (!byItem.has(t.item_index)) byItem.set(t.item_index, t.decisions || {});
  }
  const items = [...byItem.values()];
  const rows = objects.map((object) => {
    let created = 0; let updated = 0; let existed = 0;
    for (const d of items) {
      const state = classifyObject(object, d);
      if (state === 'created') created += 1;
      else if (state === 'updated') updated += 1;
      else if (state === 'existed') existed += 1;
    }
    return { object, created, updated, existed };
  });
  return rows;
}

// ── Run object side box ───────────────────────────────
// A compact created / updated grid per object type, plus a "before trigger"
// summary of how many already existed.
export function RunObjectSidebar({ run }) {
  const rows = runObjectStats(run);
  if (!rows) return null;
  const anyExisted = rows.some((r) => r.existed > 0);
  return (
    <aside className="w-60 shrink-0 rounded-2xl border border-slate-200 bg-slate-50/60 p-3">
      <div className="mb-2 text-[11px] font-black uppercase tracking-wide text-slate-400">Objects this run</div>
      <div className="grid grid-cols-[1fr_auto_auto] items-center gap-x-2 gap-y-1">
        <span className="text-[10px] font-black uppercase text-slate-400">object</span>
        <span className="text-[10px] font-black uppercase text-emerald-600 text-center">created</span>
        <span className="text-[10px] font-black uppercase text-violet-600 text-center">updated</span>
        {rows.map((r) => (
          <Fragment key={r.object}>
            <span className="truncate text-[11px] font-semibold text-slate-700">{r.object}</span>
            <span className="rounded bg-emerald-50 px-2 py-0.5 text-center text-xs font-black text-emerald-700">{r.created}</span>
            <span className="rounded bg-violet-50 px-2 py-0.5 text-center text-xs font-black text-violet-700">{r.updated}</span>
          </Fragment>
        ))}
      </div>
      {anyExisted && (
        <div className="mt-3 border-t border-slate-200 pt-2">
          <div className="text-[10px] font-black uppercase tracking-wide text-slate-400">before trigger</div>
          <div className="mt-1 space-y-0.5">
            {rows.filter((r) => r.existed > 0).map((r) => (
              <div key={r.object} className="flex items-center justify-between text-[11px]">
                <span className="text-slate-600">{r.object}</span>
                <span className="font-bold text-sky-700">{r.existed} already exist</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </aside>
  );
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
