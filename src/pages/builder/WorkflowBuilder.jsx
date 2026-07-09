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
  Info,
  Layers,
  Loader2,
  Plus,
  Save,
  Trash2,
  User,
  Zap,
} from 'lucide-react';
import { fetchBuilderCatalog, saveWorkflow } from '../../lib/workflowApi';
import { Connector, WorkflowFlow, WorkflowLane, triggerLabel } from '../../components/WorkflowDefinitionFlow';

// ── id helpers ────────────────────────────────────────────────────────────────
let idCounter = 0;
function newId(prefix) {
  idCounter += 1;
  return `${prefix}${Date.now().toString(36)}${idCounter}`;
}

// TASK-group tint palette (cycled by group index). A group's member node cards
// get a tinted border + a group-name pill in the header so membership is visible.
const GROUP_TINTS = [
  { ring: 'border-violet-400', pill: 'bg-violet-100 text-violet-700 border-violet-300', dot: 'bg-violet-500' },
  { ring: 'border-teal-400', pill: 'bg-teal-100 text-teal-700 border-teal-300', dot: 'bg-teal-500' },
  { ring: 'border-orange-400', pill: 'bg-orange-100 text-orange-700 border-orange-300', dot: 'bg-orange-500' },
  { ring: 'border-fuchsia-400', pill: 'bg-fuchsia-100 text-fuchsia-700 border-fuchsia-300', dot: 'bg-fuchsia-500' },
];
function groupTint(index) {
  return GROUP_TINTS[((index % GROUP_TINTS.length) + GROUP_TINTS.length) % GROUP_TINTS.length];
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
    return { id: newId('n'), kind: 'system', name: '', actionKey: catalog?.actions?.system?.[0]?.key || 'check_required_fields', groupId: null };
  }
  if (kind === 'task') {
    return { id: newId('n'), kind: 'task', name: '', assigneeEmployeeId: '', groupId: null, actions: [makeAction(catalog)] };
  }
  return { id: newId('n'), kind: 'condition', conditionKey: catalog?.conditions?.[0]?.key || 'patient_exists', ifTrue: [], ifFalse: [] };
}

// ── graph <-> nested sequence conversion ─────────────────────────────────────
// graphToSeq: rebuild the nested editor model from a saved definition.graph.
// `groupOfNode` maps a node id → its group id (from graph.groups) so system/task
// nodes hydrate their `groupId` for the group-membership controls.
function chainToSeq(startId, stopId, byId, groupOfNode) {
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
        ifTrue: node.ifTrue ? chainToSeq(node.ifTrue, node.join || null, byId, groupOfNode) : [],
        ifFalse: node.ifFalse ? chainToSeq(node.ifFalse, node.join || null, byId, groupOfNode) : [],
      });
      currentId = node.join || null;
    } else if (node.kind === 'task') {
      seq.push({
        id: node.id,
        kind: 'task',
        name: node.name || '',
        assigneeEmployeeId: node.assigneeEmployeeId || '',
        groupId: groupOfNode.get(node.id) || null,
        actions: (node.actions || []).map((a) => ({ id: a.id, actionKey: a.actionKey, label: a.label || '', params: a.params || {} })),
      });
      currentId = node.next || null;
    } else {
      seq.push({ id: node.id, kind: 'system', name: node.name || '', actionKey: node.actionKey, groupId: groupOfNode.get(node.id) || null });
      currentId = node.next || null;
    }
  }
  return seq;
}

function graphToSeq(graph) {
  const byId = new Map((graph?.nodes || []).map((node) => [node.id, node]));
  const groupOfNode = new Map();
  for (const group of graph?.groups || []) {
    for (const id of group.nodeIds || []) {
      if (!groupOfNode.has(id)) groupOfNode.set(id, group.id);
    }
  }
  return graph?.entry ? chainToSeq(graph.entry, null, byId, groupOfNode) : [];
}

// Rebuild the group metadata list [{id,name,info}] from a saved graph.
function graphToGroups(graph) {
  return (graph?.groups || []).map((g) => ({ id: g.id, name: g.name || '', info: g.info || '' }));
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

// Collect group membership (node ids per group) in flow/traversal order.
function collectGroupMembers(seq, membersByGroup) {
  for (const node of seq) {
    if (node.kind === 'condition') {
      collectGroupMembers(node.ifTrue, membersByGroup);
      collectGroupMembers(node.ifFalse, membersByGroup);
    } else if (node.groupId) {
      if (!membersByGroup.has(node.groupId)) membersByGroup.set(node.groupId, []);
      membersByGroup.get(node.groupId).push(node.id);
    }
  }
}

// seqToGraph: flatten nodes AND re-emit graph.groups from {groups, node.groupId}.
// Only groups that end up with ≥1 member node are emitted; the graph shape is
// otherwise unchanged (entry + nodes). Groups is authoring metadata only.
function seqToGraph(seq, catalog, groups = []) {
  const nodes = [];
  seqToNodes(seq, nodes, catalog);
  const membersByGroup = new Map();
  collectGroupMembers(seq, membersByGroup);
  const emitted = groups
    .map((g) => ({ id: g.id, name: (g.name || '').trim() || 'TASK group', info: (g.info || '').trim(), nodeIds: membersByGroup.get(g.id) || [] }))
    .filter((g) => g.nodeIds.length > 0);
  return { entry: seq[0]?.id || null, nodes, ...(emitted.length ? { groups: emitted } : {}) };
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

// Per-node group selector + membership pill, rendered in the header of a
// system/task NodeCard. Condition nodes never get this (they emit no step).
function GroupControl({ node, groups, onChange }) {
  const idx = groups.findIndex((g) => g.id === node.groupId);
  const member = idx >= 0 ? groups[idx] : null;
  const tint = member ? groupTint(idx) : null;
  return (
    <span className="ml-auto flex items-center gap-1.5">
      {member && (
        <span className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[9px] font-black uppercase tracking-wide ${tint.pill}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${tint.dot}`} /> {member.name || 'TASK group'}
        </span>
      )}
      <select
        value={node.groupId || ''}
        onChange={(e) => onChange({ ...node, groupId: e.target.value || null })}
        title="Assign this step to a TASK group"
        className="rounded-lg border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] font-bold text-slate-600 focus:border-violet-400 focus:outline-none"
      >
        <option value="">Group: —</option>
        {groups.map((g) => <option key={g.id} value={g.id}>{g.name || 'TASK group'}</option>)}
      </select>
    </span>
  );
}

function NodeShell({ tone, badge, title, onRemove, children, groupControl, ringOverride }) {
  const tones = {
    sky: { ring: 'border-sky-300', bg: 'bg-sky-50', badge: 'bg-sky-600' },
    pink: { ring: 'border-pink-300', bg: 'bg-pink-50', badge: 'bg-pink-600' },
    amber: { ring: 'border-amber-400', bg: 'bg-amber-50', badge: 'bg-amber-500' },
  };
  const t = tones[tone];
  return (
    <div className={`w-full rounded-xl border-2 ${ringOverride || t.ring} ${t.bg} p-3 shadow-sm`}>
      <div className="flex items-center gap-2">
        <span className={`rounded-md ${t.badge} px-1.5 py-0.5 text-[9px] font-black uppercase text-white`}>{badge}</span>
        <span className="text-xs font-black uppercase tracking-wide text-slate-500">{title}</span>
        {groupControl}
        <button
          type="button"
          onClick={onRemove}
          className={`${groupControl ? '' : 'ml-auto '}flex h-6 w-6 items-center justify-center rounded-md text-slate-400 hover:bg-white/70 hover:text-rose-600`}
          title="Remove this node"
        >
          <Trash2 size={13} />
        </button>
      </div>
      <div className="mt-2">{children}</div>
    </div>
  );
}

function SystemNodeCard({ node, onChange, onRemove, catalog, groups = [] }) {
  const actions = catalog?.actions?.system || [];
  const selected = actions.find((a) => a.key === node.actionKey);
  const gIdx = groups.findIndex((g) => g.id === node.groupId);
  return (
    <NodeShell
      tone="sky"
      badge="SYS"
      title="System action"
      onRemove={onRemove}
      ringOverride={gIdx >= 0 ? groupTint(gIdx).ring : undefined}
      groupControl={groups.length ? <GroupControl node={node} groups={groups} onChange={onChange} /> : undefined}
    >
      <div className="mb-2 text-[10px] text-slate-500">Runs automatically</div>
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

function TaskNodeCard({ node, onChange, onRemove, catalog, groups = [] }) {
  const employees = catalog?.employees || [];
  const gIdx = groups.findIndex((g) => g.id === node.groupId);
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
    <NodeShell
      tone="pink"
      badge="HUMAN"
      title="Task"
      onRemove={onRemove}
      ringOverride={gIdx >= 0 ? groupTint(gIdx).ring : undefined}
      groupControl={groups.length ? <GroupControl node={node} groups={groups} onChange={onChange} /> : undefined}
    >
      <div className="mb-2 text-[10px] text-rose-500">Worker must complete</div>
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

function ConditionNodeCard({ node, onChange, onRemove, catalog, groups = [] }) {
  const conditions = catalog?.conditions || [];
  const selected = conditions.find((c) => c.key === node.conditionKey);
  return (
    <NodeShell tone="amber" badge="IF" title="Condition" onRemove={onRemove}>
      <div className="mb-2 text-[10px] text-amber-600">Branches the flow</div>
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
          <div className="text-center text-[11px] font-black tracking-wide text-emerald-700">
            ✓ If condition is TRUE →
          </div>
          <SequenceEditor
            seq={node.ifTrue}
            onChange={(seq) => onChange({ ...node, ifTrue: seq })}
            catalog={catalog}
            groups={groups}
            emptyHint="add at least one node"
          />
        </div>
        <div className="rounded-xl border border-rose-200 bg-rose-50/40 p-2">
          <div className="text-center text-[11px] font-black tracking-wide text-rose-600">
            ✗ If condition is FALSE →
          </div>
          <SequenceEditor
            seq={node.ifFalse}
            onChange={(seq) => onChange({ ...node, ifFalse: seq })}
            catalog={catalog}
            groups={groups}
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

function NodeCard({ node, onChange, onRemove, catalog, groups }) {
  if (node.kind === 'system') return <SystemNodeCard node={node} onChange={onChange} onRemove={onRemove} catalog={catalog} groups={groups} />;
  if (node.kind === 'task') return <TaskNodeCard node={node} onChange={onChange} onRemove={onRemove} catalog={catalog} groups={groups} />;
  return <ConditionNodeCard node={node} onChange={onChange} onRemove={onRemove} catalog={catalog} groups={groups} />;
}

// Renders a sequence of node cards with an insert point before/after every node.
function SequenceEditor({ seq, onChange, catalog, emptyHint, groups = [] }) {
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
            groups={groups}
          />
          <InsertPoint onInsert={(kind) => insertAt(i + 1, kind)} />
        </Fragment>
      ))}
    </div>
  );
}

// Clear a removed group's membership from every system/task node in the seq
// (returns a new seq; recurses into condition branches).
function clearGroupFromSeq(seq, groupId) {
  return seq.map((node) => {
    if (node.kind === 'condition') {
      return { ...node, ifTrue: clearGroupFromSeq(node.ifTrue, groupId), ifFalse: clearGroupFromSeq(node.ifFalse, groupId) };
    }
    return node.groupId === groupId ? { ...node, groupId: null } : node;
  });
}

// Count how many system/task nodes belong to each group (for the panel badges).
function memberCounts(seq, counts = {}) {
  for (const node of seq) {
    if (node.kind === 'condition') { memberCounts(node.ifTrue, counts); memberCounts(node.ifFalse, counts); }
    else if (node.groupId) counts[node.groupId] = (counts[node.groupId] || 0) + 1;
  }
  return counts;
}

// ── TASK groups panel ─────────────────────────────────────────────────────────
// Author TASK containers: a group is {id, name, info}. Steps are assigned to a
// group via the per-node "Group:" dropdown in the Flow editor. A group with ≥1
// member renders as a "TASK-<name>" box in the preview / list / orchestrator.
function GroupsPanel({ groups, seq, onChange, onSeqChange }) {
  const counts = memberCounts(seq);
  const addGroup = () => onChange([...groups, { id: newId('g'), name: '', info: '' }]);
  const updateGroup = (id, patch) => onChange(groups.map((g) => (g.id === id ? { ...g, ...patch } : g)));
  const removeGroup = (id) => {
    onChange(groups.filter((g) => g.id !== id));
    onSeqChange(clearGroupFromSeq(seq, id)); // orphan the members back to ungrouped
  };
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <div className="flex items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-slate-700 text-white"><Layers size={14} /></span>
        <h2 className="font-bold text-slate-900">TASK groups</h2>
        <span className="ml-auto text-[10px] font-black uppercase tracking-wide text-slate-400">collapse steps into one TASK box</span>
      </div>
      <p className="mt-1 text-[11px] text-slate-500">
        Create a TASK container, then assign flow steps to it with the “Group:” dropdown on each step. Grouping is presentation only — the compiled engine steps are unchanged.
      </p>
      <div className="mt-3 space-y-2">
        {groups.length === 0 && (
          <div className="rounded-lg border border-dashed border-slate-300 px-3 py-2 text-center text-[11px] text-slate-400">
            No groups yet — add one, then tag steps into it.
          </div>
        )}
        {groups.map((g, idx) => {
          const tint = groupTint(idx);
          return (
            <div key={g.id} className={`rounded-xl border-2 ${tint.ring} bg-white p-2.5`}>
              <div className="flex items-center gap-2">
                <span className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[9px] font-black uppercase tracking-wide ${tint.pill}`}>
                  <span className={`h-1.5 w-1.5 rounded-full ${tint.dot}`} /> TASK
                </span>
                <span className="text-[10px] font-mono text-slate-400">{counts[g.id] || 0} step{(counts[g.id] || 0) === 1 ? '' : 's'}</span>
                <button
                  type="button"
                  onClick={() => removeGroup(g.id)}
                  className="ml-auto flex h-6 w-6 items-center justify-center rounded-md text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                  title="Delete group (members become ungrouped)"
                >
                  <Trash2 size={13} />
                </button>
              </div>
              <input
                type="text"
                value={g.name}
                onChange={(e) => updateGroup(g.id, { name: e.target.value })}
                placeholder='TASK name — e.g. "Update Object Module"'
                className={INPUT_CLS}
              />
              <input
                type="text"
                value={g.info}
                onChange={(e) => updateGroup(g.id, { info: e.target.value })}
                placeholder="What this TASK does (shown in the ⓘ popover)"
                className={INPUT_CLS}
              />
            </div>
          );
        })}
      </div>
      <button
        type="button"
        onClick={addGroup}
        className="mt-3 inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs font-bold text-slate-700 hover:bg-slate-50"
      >
        <Plus size={12} /> Add TASK group
      </button>
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

// ── Builder Tips collapsible info box ─────────────────────────────────────────
function BuilderTips() {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm font-semibold text-slate-600 hover:bg-slate-100 rounded-xl"
      >
        <Info size={14} className="shrink-0 text-slate-400" />
        <span>Builder Guide</span>
        {open ? <ChevronUp size={13} className="ml-auto" /> : <ChevronDown size={13} className="ml-auto" />}
      </button>
      {open && (
        <ul className="space-y-1.5 px-4 pb-3 pt-1 text-[11px] text-slate-600">
          <li>• System nodes run automatically in sequence — no worker needed.</li>
          <li>• Human task nodes pause and wait for a worker to complete one or more actions.</li>
          <li>• Condition nodes branch the flow: add steps for both the TRUE and FALSE paths.</li>
          <li>• Groups (TASK-name) collapse multiple steps into one visual block in the flowchart.</li>
          <li>• Save compiles and validates the workflow before storing — errors appear inline.</li>
        </ul>
      )}
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
  const [groups, setGroups] = useState(() => (workflow?.graph ? graphToGroups(workflow.graph) : []));
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
  }, [seq, groups, trigger, name, description]);

  const previewSteps = useMemo(() => compilePreview(seq, catalog), [seq, catalog]);
  const displaySteps = serverSteps || previewSteps;
  // megaGroups for the preview: map each authored group → the compiled step ids
  // of its member nodes (same derivation the server does). Steps compiled from
  // condition nodes never appear here. Empty groups are dropped. This lets the
  // preview render the grouped hierarchy via WorkflowLane → MegaGroupFlow.
  const previewMegaGroups = useMemo(() => {
    if (!groups.length) return null;
    const stepIdSet = new Set(displaySteps.map((s) => s.id));
    const membersByGroup = new Map();
    collectGroupMembers(seq, membersByGroup);
    const mg = groups
      .map((g) => ({
        id: g.id,
        name: (g.name || '').trim() || 'TASK group',
        info: (g.info || '').trim(),
        stepIds: (membersByGroup.get(g.id) || []).filter((id) => stepIdSet.has(id)),
      }))
      .filter((g) => g.stepIds.length > 0);
    return mg.length ? mg : null;
  }, [groups, seq, displaySteps]);
  const previewDefinition = useMemo(() => ({
    name: name.trim() || 'Untitled workflow',
    description,
    trigger,
    builder: true,
    steps: displaySteps,
    ...(previewMegaGroups ? { megaGroups: previewMegaGroups } : {}),
  }), [name, description, trigger, displaySteps, previewMegaGroups]);

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
      const graph = seqToGraph(seq, catalog, groups);
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
          {workflow && (
            <div className="mb-0.5 flex items-center gap-1.5 text-[11px] text-slate-400">
              <span>Workflows</span>
              <span>/</span>
              <span className="font-semibold text-slate-600">Editing: {workflow.name || editingId}</span>
            </div>
          )}
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

          <div className="mt-4">
            <BuilderTips />
          </div>

          <div className="mt-4">
            <GroupsPanel groups={groups} seq={seq} onChange={setGroups} onSeqChange={setSeq} />
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
                <SequenceEditor seq={seq} onChange={setSeq} catalog={catalog} groups={groups} emptyHint="add the first node" />
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
            ) : previewMegaGroups ? (
              // Grouped: render via the shared WorkflowLane (megaGroups → MegaGroupFlow),
              // identical to the Workflow list card + Orchestrator run card.
              <div className="mt-3 overflow-x-auto">
                <WorkflowLane
                  definition={previewDefinition}
                  tasks={[]}
                  accent="violet"
                  employeesById={{}}
                  subtitle={`${triggerLabel(trigger)} · ${displaySteps.length} step${displaySteps.length === 1 ? '' : 's'} · ${previewMegaGroups.length} TASK group${previewMegaGroups.length === 1 ? '' : 's'}`}
                />
              </div>
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
