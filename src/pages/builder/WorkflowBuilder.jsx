// Workflow Builder — vertical n8n-like flow editor (DESIGN §6).
//
// The editor works on a NESTED sequence model (easier to edit than the flat
// linked-list graph): a sequence is an ordered list of nodes; a condition node
// holds its own ifTrue / ifFalse sub-sequences and implicitly re-joins at the
// next node in the parent sequence. On save the sequence is flattened into the
// server's graph shape ({ entry, nodes[] } with next/ifTrue/ifFalse/join
// pointers) and sent to saveWorkflow, which validates + compiles it. A
// client-side compile mirror feeds the live preview (rendered with the shared
// WorkflowFlow flowchart); after a successful save the preview switches to the
// server-compiled steps until the next edit.
import { Fragment, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Cog,
  GitFork,
  Loader2,
  Plus,
  Save,
  Trash2,
  User,
  Zap,
} from 'lucide-react';
import { fetchBuilderCatalog, saveWorkflow } from '../../lib/workflowApi';
import { Connector, WorkflowFlow, triggerLabel } from '../../components/WorkflowDefinitionFlow';

// ── id helpers ────────────────────────────────────────────────────────────────
let idCounter = 0;
function newId(prefix) {
  idCounter += 1;
  return `${prefix}${Date.now().toString(36)}${idCounter}`;
}

// Extra per-action params surfaced in the task editor (design §4.2 example).
const ACTION_PARAM_FIELDS = {
  send_email_to_physician: [
    { key: 'subjectTemplate', label: 'Subject template', placeholder: 'Order {{orderNumber}} ready for signature' },
  ],
  send_email_to_hhah: [
    { key: 'subjectTemplate', label: 'Subject template', placeholder: 'Message from Command Center' },
  ],
};

const INPUT_CLS = 'mt-1 w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm text-slate-800 placeholder:text-slate-300 focus:border-violet-400 focus:outline-none';

function makeAction(catalog) {
  return { id: newId('a'), actionKey: catalog?.actions?.human?.[0]?.key || 'confirm_checklist', label: '', params: {} };
}

function makeNode(kind, catalog) {
  if (kind === 'system') {
    return { id: newId('n'), kind: 'system', name: '', actionKey: catalog?.actions?.system?.[0]?.key || 'check_required_fields' };
  }
  if (kind === 'task') {
    return { id: newId('n'), kind: 'task', name: '', assigneeEmployeeId: '', actions: [makeAction(catalog)] };
  }
  return { id: newId('n'), kind: 'condition', conditionKey: catalog?.conditions?.[0]?.key || 'patient_exists', ifTrue: [], ifFalse: [] };
}

// ── graph <-> nested sequence conversion ─────────────────────────────────────
// graphToSeq: rebuild the nested editor model from a saved definition.graph.
function chainToSeq(startId, stopId, byId) {
  const seq = [];
  let currentId = startId;
  const guard = new Set();
  while (currentId && currentId !== stopId && !guard.has(currentId)) {
    guard.add(currentId);
    const node = byId.get(currentId);
    if (!node) break;
    if (node.kind === 'condition') {
      seq.push({
        id: node.id,
        kind: 'condition',
        conditionKey: node.conditionKey,
        ifTrue: node.ifTrue ? chainToSeq(node.ifTrue, node.join || null, byId) : [],
        ifFalse: node.ifFalse ? chainToSeq(node.ifFalse, node.join || null, byId) : [],
      });
      currentId = node.join || null;
    } else if (node.kind === 'task') {
      seq.push({
        id: node.id,
        kind: 'task',
        name: node.name || '',
        assigneeEmployeeId: node.assigneeEmployeeId || '',
        actions: (node.actions || []).map((a) => ({ id: a.id, actionKey: a.actionKey, label: a.label || '', params: a.params || {} })),
      });
      currentId = node.next || null;
    } else {
      seq.push({ id: node.id, kind: 'system', name: node.name || '', actionKey: node.actionKey });
      currentId = node.next || null;
    }
  }
  return seq;
}

function graphToSeq(graph) {
  const byId = new Map((graph?.nodes || []).map((node) => [node.id, node]));
  return graph?.entry ? chainToSeq(graph.entry, null, byId) : [];
}

// seqToGraph: flatten the nested model to the server graph shape. A condition's
// join is the next node in the same sequence; branch tails end with next=null
// (the server compiler stops branch walks at the join id anyway).
function seqToNodes(seq, out, catalog) {
  const systemLabel = (key) => (catalog?.actions?.system || []).find((a) => a.key === key)?.label || key;
  const humanLabel = (key) => (catalog?.actions?.human || []).find((a) => a.key === key)?.label || key;
  for (let i = 0; i < seq.length; i += 1) {
    const node = seq[i];
    const nextId = seq[i + 1]?.id || null;
    if (node.kind === 'condition') {
      out.push({
        id: node.id,
        kind: 'condition',
        name: node.conditionKey,
        conditionKey: node.conditionKey,
        ifTrue: node.ifTrue[0]?.id || null,
        ifFalse: node.ifFalse[0]?.id || null,
        join: nextId,
      });
      seqToNodes(node.ifTrue, out, catalog);
      seqToNodes(node.ifFalse, out, catalog);
    } else if (node.kind === 'task') {
      out.push({
        id: node.id,
        kind: 'task',
        name: node.name.trim() || 'Task',
        assigneeEmployeeId: node.assigneeEmployeeId || null,
        actions: node.actions.map((a) => ({
          id: a.id,
          actionKey: a.actionKey,
          label: (a.label || '').trim() || humanLabel(a.actionKey),
          params: a.params || {},
        })),
        next: nextId,
      });
    } else {
      out.push({
        id: node.id,
        kind: 'system',
        name: node.name.trim() || systemLabel(node.actionKey),
        actionKey: node.actionKey,
        next: nextId,
      });
    }
  }
}

function seqToGraph(seq, catalog) {
  const nodes = [];
  seqToNodes(seq, nodes, catalog);
  return { entry: seq[0]?.id || null, nodes };
}

// ── client-side compile mirror (preview only; server compile is authoritative) ─
function compilePreview(seq, catalog) {
  const steps = [];
  const conditionByKey = Object.fromEntries((catalog?.conditions || []).map((c) => [c.key, c]));
  const systemByKey = Object.fromEntries((catalog?.actions?.system || []).map((a) => [a.key, a]));
  const humanByKey = Object.fromEntries((catalog?.actions?.human || []).map((a) => [a.key, a]));

  function walk(list, preReq, condition) {
    let tails = preReq;
    let entryCondition = condition;
    for (const node of list) {
      if (node.kind === 'condition') {
        const negation = conditionByKey[node.conditionKey]?.negation || `not_${node.conditionKey}`;
        const trueTails = node.ifTrue.length ? walk(node.ifTrue, tails, node.conditionKey) : tails;
        const falseTails = node.ifFalse.length ? walk(node.ifFalse, tails, negation) : tails;
        tails = [...new Set([...trueTails, ...falseTails])];
        entryCondition = null;
        continue;
      }
      const base = {
        id: node.id,
        preReq: [...tails],
        ...(entryCondition ? { condition: entryCondition } : {}),
      };
      if (node.kind === 'system') {
        steps.push({
          ...base,
          name: node.name.trim() || systemByKey[node.actionKey]?.label || node.actionKey,
          actor: node.actionKey === 'ai_extract_pdf_fields' ? 'ai' : 'system',
          taskKey: node.actionKey,
        });
      } else {
        steps.push({
          ...base,
          name: node.name.trim() || 'Task',
          actor: 'human',
          taskKey: 'human.performActions',
          description: node.actions.map((a) => (a.label || '').trim() || humanByKey[a.actionKey]?.label || a.actionKey).join(' · '),
        });
      }
      tails = [node.id];
      entryCondition = null;
    }
    return tails;
  }

  walk(seq, [], null);
  return steps;
}

// Minimal client checks for the two things with the worst late-feedback UX; the
// server (validateGraph) remains the authority and its messages render inline.
function clientValidate({ name, seq }) {
  const messages = [];
  if (!name.trim()) messages.push('Give the workflow a name.');
  if (!seq.length) messages.push('Add at least one node to the workflow.');
  const visit = (list) => {
    for (const node of list) {
      if (node.kind === 'task' && !node.name.trim()) {
        messages.push('Every task needs a name — it is what the employee sees in their bucket.');
      }
      if (node.kind === 'condition') {
        if (!node.ifTrue.length) messages.push(`Condition "${node.conditionKey}" needs at least one node in its TRUE branch.`);
        visit(node.ifTrue);
        visit(node.ifFalse);
      }
    }
  };
  visit(seq);
  return messages;
}

// ── small building blocks ─────────────────────────────────────────────────────
function InsertPoint({ onInsert, hint }) {
  const [open, setOpen] = useState(false);
  const item = (kind, label, cls) => (
    <button
      type="button"
      onClick={() => { onInsert(kind); setOpen(false); }}
      className={`flex items-center gap-2 px-3 py-2 text-left text-xs font-bold hover:bg-slate-50 ${cls}`}
    >
      {kind === 'system' && <Cog size={13} />}
      {kind === 'task' && <User size={13} />}
      {kind === 'condition' && <GitFork size={13} />}
      {label}
    </button>
  );
  return (
    <div className="relative flex flex-col items-center py-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-6 w-6 items-center justify-center rounded-full border border-dashed border-slate-300 bg-white text-slate-400 hover:border-violet-400 hover:text-violet-600"
        title="Insert a node here"
      >
        <Plus size={13} />
      </button>
      {hint && !open && <span className="mt-1 text-[10px] text-slate-400">{hint}</span>}
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute top-7 z-40 flex w-48 flex-col divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl">
            {item('system', 'System action', 'text-sky-700')}
            {item('task', 'Task (human)', 'text-pink-700')}
            {item('condition', 'Condition (if / else)', 'text-amber-700')}
          </div>
        </>
      )}
    </div>
  );
}

function NodeShell({ tone, badge, title, onRemove, children }) {
  const tones = {
    sky: { ring: 'border-sky-300', bg: 'bg-sky-50', badge: 'bg-sky-600' },
    pink: { ring: 'border-pink-300', bg: 'bg-pink-50', badge: 'bg-pink-600' },
    amber: { ring: 'border-amber-400', bg: 'bg-amber-50', badge: 'bg-amber-500' },
  };
  const t = tones[tone];
  return (
    <div className={`w-full rounded-xl border-2 ${t.ring} ${t.bg} p-3 shadow-sm`}>
      <div className="flex items-center gap-2">
        <span className={`rounded-md ${t.badge} px-1.5 py-0.5 text-[9px] font-black uppercase text-white`}>{badge}</span>
        <span className="text-xs font-black uppercase tracking-wide text-slate-500">{title}</span>
        <button
          type="button"
          onClick={onRemove}
          className="ml-auto flex h-6 w-6 items-center justify-center rounded-md text-slate-400 hover:bg-white/70 hover:text-rose-600"
          title="Remove this node"
        >
          <Trash2 size={13} />
        </button>
      </div>
      <div className="mt-2">{children}</div>
    </div>
  );
}

function SystemNodeCard({ node, onChange, onRemove, catalog }) {
  const actions = catalog?.actions?.system || [];
  const selected = actions.find((a) => a.key === node.actionKey);
  return (
    <NodeShell tone="sky" badge="SYS" title="System action" onRemove={onRemove}>
      <label className="block">
        <span className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Action</span>
        <select
          value={node.actionKey}
          onChange={(e) => onChange({ ...node, actionKey: e.target.value })}
          className={INPUT_CLS}
        >
          {actions.map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}
        </select>
      </label>
      <label className="mt-2 block">
        <span className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Step name (optional)</span>
        <input
          type="text"
          value={node.name}
          onChange={(e) => onChange({ ...node, name: e.target.value })}
          placeholder={selected?.label || 'Step name'}
          className={INPUT_CLS}
        />
      </label>
    </NodeShell>
  );
}

function TaskActionRow({ action, index, count, onChange, onMove, onRemove, catalog }) {
  const humanActions = catalog?.actions?.human || [];
  const spec = humanActions.find((a) => a.key === action.actionKey);
  const paramFields = ACTION_PARAM_FIELDS[action.actionKey] || [];
  return (
    <div className="rounded-lg border border-pink-200 bg-white/80 p-2">
      <div className="flex items-center gap-1.5">
        <span className="w-5 text-center font-mono text-[10px] font-bold text-pink-400">{index + 1}</span>
        <select
          value={action.actionKey}
          onChange={(e) => onChange({ ...action, actionKey: e.target.value })}
          className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-800 focus:border-violet-400 focus:outline-none"
        >
          {humanActions.map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}
        </select>
        <button type="button" disabled={index === 0} onClick={() => onMove(-1)} title="Move up"
          className="flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-slate-100 disabled:opacity-30">
          <ChevronUp size={13} />
        </button>
        <button type="button" disabled={index === count - 1} onClick={() => onMove(1)} title="Move down"
          className="flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-slate-100 disabled:opacity-30">
          <ChevronDown size={13} />
        </button>
        <button type="button" disabled={count === 1} onClick={onRemove} title="Remove action"
          className="flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-30">
          <Trash2 size={12} />
        </button>
      </div>
      <input
        type="text"
        value={action.label}
        onChange={(e) => onChange({ ...action, label: e.target.value })}
        placeholder={spec ? `Label — default: ${spec.label}` : 'Action label'}
        className="mt-1.5 w-full rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 placeholder:text-slate-300 focus:border-violet-400 focus:outline-none"
      />
      {paramFields.map((field) => (
        <input
          key={field.key}
          type="text"
          value={action.params?.[field.key] || ''}
          onChange={(e) => onChange({ ...action, params: { ...action.params, [field.key]: e.target.value } })}
          placeholder={`${field.label} — e.g. ${field.placeholder}`}
          className="mt-1.5 w-full rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 placeholder:text-slate-300 focus:border-violet-400 focus:outline-none"
        />
      ))}
      {spec?.inputs?.length > 0 && (
        <div className="mt-1 text-[10px] text-slate-400">worker fills: {spec.inputs.join(', ')}</div>
      )}
    </div>
  );
}

function TaskNodeCard({ node, onChange, onRemove, catalog }) {
  const employees = catalog?.employees || [];
  const updateAction = (i, next) => {
    const actions = [...node.actions];
    actions[i] = next;
    onChange({ ...node, actions });
  };
  const moveAction = (i, dir) => {
    const j = i + dir;
    if (j < 0 || j >= node.actions.length) return;
    const actions = [...node.actions];
    [actions[i], actions[j]] = [actions[j], actions[i]];
    onChange({ ...node, actions });
  };
  const removeAction = (i) => {
    if (node.actions.length === 1) return;
    onChange({ ...node, actions: node.actions.filter((_, idx) => idx !== i) });
  };
  return (
    <NodeShell tone="pink" badge="HUMAN" title="Task" onRemove={onRemove}>
      <label className="block">
        <span className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Task name <span className="text-rose-500">*</span></span>
        <input
          type="text"
          value={node.name}
          onChange={(e) => onChange({ ...node, name: e.target.value })}
          placeholder='e.g. "Send Orders To Physician"'
          className={INPUT_CLS}
        />
      </label>
      <label className="mt-2 block">
        <span className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Assigned employee <span className="text-rose-500">*</span></span>
        <select
          value={node.assigneeEmployeeId}
          onChange={(e) => onChange({ ...node, assigneeEmployeeId: e.target.value })}
          className={INPUT_CLS}
        >
          <option value="">— pick an employee —</option>
          {employees.map((emp) => (
            <option key={emp.id} value={emp.id}>{emp.display_name} ({emp.username}){emp.job_role ? ` · ${emp.job_role}` : ''}</option>
          ))}
        </select>
      </label>
      {employees.length === 0 && (
        <div className="mt-1.5 rounded-lg border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
          No employees yet — create one on the Employees page first. A task cannot be saved without an assignee.
        </div>
      )}
      <div className="mt-3">
        <div className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Actions (done in order)</div>
        <div className="mt-1.5 space-y-1.5">
          {node.actions.map((action, i) => (
            <TaskActionRow
              key={action.id}
              action={action}
              index={i}
              count={node.actions.length}
              onChange={(next) => updateAction(i, next)}
              onMove={(dir) => moveAction(i, dir)}
              onRemove={() => removeAction(i)}
              catalog={catalog}
            />
          ))}
        </div>
        <button
          type="button"
          onClick={() => onChange({ ...node, actions: [...node.actions, makeAction(catalog)] })}
          className="mt-2 inline-flex items-center gap-1 rounded-lg border border-pink-300 bg-white px-2.5 py-1 text-xs font-bold text-pink-700 hover:bg-pink-50"
        >
          <Plus size={12} /> Add action
        </button>
      </div>
    </NodeShell>
  );
}

function ConditionNodeCard({ node, onChange, onRemove, catalog }) {
  const conditions = catalog?.conditions || [];
  const selected = conditions.find((c) => c.key === node.conditionKey);
  const negation = conditions.find((c) => c.key === selected?.negation);
  return (
    <NodeShell tone="amber" badge="IF" title="Condition" onRemove={onRemove}>
      <label className="block">
        <span className="text-[10px] font-bold uppercase tracking-wide text-slate-500">If …</span>
        <select
          value={node.conditionKey}
          onChange={(e) => onChange({ ...node, conditionKey: e.target.value })}
          className={INPUT_CLS}
        >
          {conditions.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
        </select>
      </label>
      {selected?.description && <div className="mt-1 text-[10px] text-slate-500">{selected.description}</div>}
      <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
        <div className="rounded-xl border border-emerald-200 bg-emerald-50/50 p-2">
          <div className="text-center text-[10px] font-black uppercase tracking-wide text-emerald-600">
            TRUE · {selected?.label || node.conditionKey}
          </div>
          <SequenceEditor
            seq={node.ifTrue}
            onChange={(seq) => onChange({ ...node, ifTrue: seq })}
            catalog={catalog}
            emptyHint="add at least one node"
          />
        </div>
        <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-2">
          <div className="text-center text-[10px] font-black uppercase tracking-wide text-slate-500">
            FALSE · {negation?.label || `not ${selected?.label || node.conditionKey}`}
          </div>
          <SequenceEditor
            seq={node.ifFalse}
            onChange={(seq) => onChange({ ...node, ifFalse: seq })}
            catalog={catalog}
            emptyHint="optional — skips to join"
          />
        </div>
      </div>
      <div className="mt-2 text-center text-[10px] font-black uppercase tracking-wide text-amber-600">
        ↓ branches re-join and continue below ↓
      </div>
    </NodeShell>
  );
}

function NodeCard({ node, onChange, onRemove, catalog }) {
  if (node.kind === 'system') return <SystemNodeCard node={node} onChange={onChange} onRemove={onRemove} catalog={catalog} />;
  if (node.kind === 'task') return <TaskNodeCard node={node} onChange={onChange} onRemove={onRemove} catalog={catalog} />;
  return <ConditionNodeCard node={node} onChange={onChange} onRemove={onRemove} catalog={catalog} />;
}

// Renders a sequence of node cards with an insert point before/after every node.
function SequenceEditor({ seq, onChange, catalog, emptyHint }) {
  const insertAt = (index, kind) => {
    const next = [...seq];
    next.splice(index, 0, makeNode(kind, catalog));
    onChange(next);
  };
  const updateAt = (index, node) => {
    const next = [...seq];
    next[index] = node;
    onChange(next);
  };
  const removeAt = (index) => onChange(seq.filter((_, i) => i !== index));

  if (!seq.length) {
    return (
      <div className="flex flex-col items-center">
        <InsertPoint onInsert={(kind) => insertAt(0, kind)} hint={emptyHint} />
      </div>
    );
  }
  return (
    <div className="flex w-full flex-col items-center">
      <InsertPoint onInsert={(kind) => insertAt(0, kind)} />
      {seq.map((node, i) => (
        <Fragment key={node.id}>
          <NodeCard
            node={node}
            onChange={(next) => updateAt(i, next)}
            onRemove={() => removeAt(i)}
            catalog={catalog}
          />
          <InsertPoint onInsert={(kind) => insertAt(i + 1, kind)} />
        </Fragment>
      ))}
    </div>
  );
}

function TriggerCard({ trigger, onChange, catalog, docUploadClash }) {
  const triggers = catalog?.triggers || [];
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <div className="flex items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-violet-600 text-white"><Zap size={14} /></span>
        <h2 className="font-bold text-slate-900">Trigger</h2>
        <span className="ml-auto text-[10px] font-black uppercase tracking-wide text-slate-400">starts the workflow</span>
      </div>
      <div className="mt-3 space-y-2">
        {triggers.map((t) => (
          <label
            key={t.key}
            className={`flex cursor-pointer items-start gap-2.5 rounded-xl border px-3 py-2 ${trigger.type === t.key ? 'border-violet-400 bg-violet-50' : 'border-slate-200 hover:border-violet-200'}`}
          >
            <input
              type="radio"
              name="trigger"
              checked={trigger.type === t.key}
              onChange={() => onChange({ type: t.key, ...(t.key === 'time_interval' ? { intervalSeconds: trigger.intervalSeconds || 60 } : {}) })}
              className="mt-1 accent-violet-600"
            />
            <span className="min-w-0">
              <span className="block text-sm font-bold text-slate-800">{t.label}</span>
              <span className="block text-[11px] text-slate-500">{t.description}</span>
              {t.key === 'time_interval' && trigger.type === 'time_interval' && (
                <span className="mt-1.5 flex items-center gap-2">
                  <span className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Every</span>
                  <input
                    type="number"
                    min={5}
                    value={trigger.intervalSeconds ?? 60}
                    onChange={(e) => onChange({ type: 'time_interval', intervalSeconds: Number(e.target.value) })}
                    onClick={(e) => e.preventDefault()}
                    className="w-24 rounded-lg border border-slate-200 bg-white px-2 py-1 text-sm text-slate-800 focus:border-violet-400 focus:outline-none"
                  />
                  <span className="text-xs text-slate-500">seconds (min 5)</span>
                </span>
              )}
              {t.key === 'document_upload' && trigger.type === 'document_upload' && docUploadClash > 0 && (
                <span className="mt-1.5 flex items-start gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-2 py-1.5 text-[11px] font-semibold text-amber-800">
                  <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                  {docUploadClash} other active builder workflow{docUploadClash > 1 ? 's' : ''} already use{docUploadClash > 1 ? '' : 's'} this
                  trigger — one HHAH upload will start a run of EACH of them plus this one.
                </span>
              )}
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}

// ── main page ─────────────────────────────────────────────────────────────────
// Props: workflow (mapped definition row for edit mode; null = new),
// existingWorkflows (for the duplicate document_upload warning), onDone().
export default function WorkflowBuilder({ workflow = null, existingWorkflows = [], onDone }) {
  const [catalog, setCatalog] = useState(null);
  const [catalogError, setCatalogError] = useState('');
  const [editingId, setEditingId] = useState(workflow?.id || null);
  const [name, setName] = useState(workflow?.name || '');
  const [description, setDescription] = useState(workflow?.description || '');
  const [trigger, setTrigger] = useState(workflow?.trigger || { type: 'manual' });
  const [seq, setSeq] = useState(() => (workflow?.graph ? graphToSeq(workflow.graph) : []));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);       // { message, messages[] }
  const [savedInfo, setSavedInfo] = useState(null);       // { version }
  const [serverSteps, setServerSteps] = useState(null);   // authoritative preview after save

  useEffect(() => {
    let cancelled = false;
    fetchBuilderCatalog()
      .then((body) => { if (!cancelled) { setCatalog(body); setCatalogError(''); } })
      .catch((error) => { if (!cancelled) setCatalogError(error.message); });
    return () => { cancelled = true; };
  }, []);

  // Any edit invalidates the last server compile + saved banner.
  useEffect(() => {
    setServerSteps(null);
    setSavedInfo(null);
  }, [seq, trigger, name, description]);

  const previewSteps = useMemo(() => compilePreview(seq, catalog), [seq, catalog]);
  const displaySteps = serverSteps || previewSteps;

  const docUploadClash = existingWorkflows.filter(
    (wf) => wf.kind === 'builder' && wf.id !== editingId && wf.trigger?.type === 'document_upload',
  ).length;

  async function handleSave() {
    setSaveError(null);
    setSavedInfo(null);
    const messages = clientValidate({ name, seq });
    if (messages.length) {
      setSaveError({ message: 'Fix these before saving', messages });
      return;
    }
    setSaving(true);
    try {
      const graph = seqToGraph(seq, catalog);
      const body = await saveWorkflow({ id: editingId || undefined, name: name.trim(), description, trigger, graph });
      setEditingId(body.workflow?.id || editingId);
      setServerSteps(body.steps || null);
      setSavedInfo({ version: body.workflow?.version });
    } catch (error) {
      setSaveError({ message: error.message, messages: error.messages || [] });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="p-6">
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => onDone?.()}
          className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50"
        >
          <ArrowLeft size={14} /> Workflows
        </button>
        <div>
          <h1 className="text-2xl font-bold text-slate-800">{workflow ? 'Edit workflow' : 'New workflow'}</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            {editingId ? <span className="font-mono text-[11px]">{editingId}</span> : 'Pick a trigger, then add system actions, tasks and conditions.'}
          </p>
        </div>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="ml-auto inline-flex items-center gap-2 rounded-xl bg-violet-600 px-4 py-2 text-sm font-bold text-white hover:bg-violet-700 disabled:opacity-60"
        >
          {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
          Save workflow
        </button>
      </div>

      {catalogError && (
        <div className="mb-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          Builder palette unavailable: {catalogError}
        </div>
      )}
      {saveError && (
        <div className="mb-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3">
          <div className="text-sm font-bold text-rose-700">{saveError.message}</div>
          {saveError.messages.length > 0 && (
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-rose-700">
              {saveError.messages.map((msg, i) => <li key={i}>{msg}</li>)}
            </ul>
          )}
        </div>
      )}
      {savedInfo && (
        <div className="mb-4 flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-700">
          <CheckCircle2 size={16} /> Saved — version {savedInfo.version} is now the active definition.
          <button type="button" onClick={() => onDone?.()} className="ml-auto rounded-lg border border-emerald-300 bg-white px-3 py-1 text-xs font-bold text-emerald-700 hover:bg-emerald-50">
            Back to workflows
          </button>
        </div>
      )}

      <div className="flex items-start gap-6">
        {/* ── editor column ── */}
        <div className="min-w-0 flex-1">
          <div className="rounded-2xl border border-slate-200 bg-white p-4">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <label className="block">
                <span className="text-xs font-bold uppercase tracking-wide text-slate-500">Workflow name <span className="text-rose-500">*</span></span>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder='e.g. "HHAH Intake & Physician Send"'
                  className={INPUT_CLS}
                />
              </label>
              <label className="block">
                <span className="text-xs font-bold uppercase tracking-wide text-slate-500">Description</span>
                <input
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="What this workflow does"
                  className={INPUT_CLS}
                />
              </label>
            </div>
          </div>

          <div className="mt-4">
            <TriggerCard trigger={trigger} onChange={setTrigger} catalog={catalog} docUploadClash={docUploadClash} />
          </div>

          <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-4">
            <div className="mb-1 flex items-center gap-2">
              <h2 className="font-bold text-slate-900">Flow</h2>
              <span className="text-[10px] font-black uppercase tracking-wide text-slate-400">top to bottom · use ＋ to insert</span>
            </div>
            {!catalog && !catalogError ? (
              <div className="flex items-center gap-2 py-6 text-sm text-slate-400">
                <Loader2 size={15} className="animate-spin" /> Loading palette…
              </div>
            ) : (
              <div className="mx-auto max-w-2xl">
                <div className="mx-auto w-fit rounded-full border-2 border-slate-300 bg-slate-50 px-4 py-1 text-xs font-black text-slate-600">
                  START · {triggerLabel(trigger)}
                </div>
                <SequenceEditor seq={seq} onChange={setSeq} catalog={catalog} emptyHint="add the first node" />
                <div className="mx-auto mt-1 w-fit rounded-full border-2 border-slate-300 bg-slate-50 px-4 py-1 text-xs font-black text-slate-600">END</div>
              </div>
            )}
          </div>
        </div>

        {/* ── live preview column ── */}
        <aside className="sticky top-6 hidden w-[26rem] shrink-0 xl:block">
          <div className="max-h-[calc(100vh-3rem)] overflow-y-auto rounded-2xl border border-slate-200 bg-white p-4">
            <div className="flex items-center gap-2">
              <h2 className="font-bold text-slate-900">Live preview</h2>
              <span className={`ml-auto rounded-full border px-2 py-0.5 text-[10px] font-black uppercase tracking-wide ${serverSteps ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-slate-200 bg-slate-50 text-slate-500'}`}>
                {serverSteps ? 'server-compiled ✓' : 'draft'}
              </span>
            </div>
            <p className="mt-0.5 text-[11px] text-slate-400">Compiled steps as the engine will run them.</p>
            {displaySteps.length === 0 ? (
              <div className="py-10 text-center text-sm text-slate-400">Add nodes to see the flowchart.</div>
            ) : (
              <div className="mt-3 overflow-x-auto">
                <div className="mx-auto w-fit rounded-full border-2 border-slate-300 bg-slate-50 px-4 py-1 text-xs font-black text-slate-600">
                  START · {triggerLabel(trigger)}
                </div>
                <Connector />
                <WorkflowFlow definition={{ steps: displaySteps }} tasks={[]} />
                <Connector />
                <div className="mx-auto mt-1 w-fit rounded-full border-2 border-slate-300 bg-slate-50 px-4 py-1 text-xs font-black text-slate-600">END</div>
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
