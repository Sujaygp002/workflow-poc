// Compiles a builder graph (editable source of truth) into the exact steps[]
// shape the existing workflow engine executes. See DESIGN §4.2/§4.4.
//
// Graph nodes: { id, kind: 'system'|'task'|'condition', name, ... } with linear
// `next` pointers; condition nodes have ifTrue/ifFalse chains that re-join at
// `join` (or end as null). A condition node emits NO step: the true-chain head
// gets `condition: conditionKey`, the false-chain head gets the negation, and
// the join step's preReq is [tailOf(ifTrue), tailOf(ifFalse)] — the engine
// treats `skipped` as satisfying preReqs so the untaken branch never blocks.
import { ACTIONS, CONDITIONS, HUMAN_ACTIONS, TRIGGERS } from './builderCatalog.js';
import { getEmployee } from './identityRepo.js';
import { httpError } from './auth.js';

const TRIGGER_KEYS = new Set(TRIGGERS.map((t) => t.key));

export async function validateGraph(graph, trigger) {
  const messages = [];
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const byId = new Map();

  if (!trigger || !TRIGGER_KEYS.has(trigger.type)) {
    messages.push(`Trigger is required and must be one of: ${[...TRIGGER_KEYS].join(', ')}.`);
  } else if (trigger.type === 'time_interval') {
    const seconds = Number(trigger.intervalSeconds);
    if (!Number.isFinite(seconds) || seconds < 5) messages.push('time_interval trigger needs intervalSeconds >= 5.');
  }

  if (!nodes.length) messages.push('The workflow needs at least one node.');
  for (const node of nodes) {
    if (!node.id) { messages.push('Every node needs an id.'); continue; }
    if (byId.has(node.id)) messages.push(`Duplicate node id "${node.id}".`);
    byId.set(node.id, node);
  }
  if (!graph?.entry || !byId.has(graph.entry)) {
    messages.push('graph.entry must reference an existing node.');
  }

  for (const node of nodes) {
    if (node.kind === 'system') {
      if (!ACTIONS[node.actionKey]) messages.push(`Node "${node.id}": unknown system action "${node.actionKey}".`);
    } else if (node.kind === 'task') {
      const actions = Array.isArray(node.actions) ? node.actions : [];
      if (!actions.length) messages.push(`Task "${node.name || node.id}" needs at least one action.`);
      const actionIds = new Set();
      for (const action of actions) {
        if (!action.id) messages.push(`Task "${node.id}": every action needs an id.`);
        else if (actionIds.has(action.id)) messages.push(`Task "${node.id}": duplicate action id "${action.id}".`);
        actionIds.add(action.id);
        if (!HUMAN_ACTIONS[action.actionKey]) {
          messages.push(`Task "${node.name || node.id}": unknown action "${action.actionKey}".`);
        }
      }
      if (!node.assigneeEmployeeId) {
        messages.push(`Task "${node.name || node.id}" must be assigned to an employee.`);
      } else {
        const employee = await getEmployee(node.assigneeEmployeeId).catch(() => null);
        if (!employee) messages.push(`Task "${node.name || node.id}": assignee employee not found.`);
        else if (!employee.active) messages.push(`Task "${node.name || node.id}": assignee employee is inactive.`);
      }
    } else if (node.kind === 'condition') {
      if (!CONDITIONS[node.conditionKey]) messages.push(`Condition "${node.id}": unknown condition "${node.conditionKey}".`);
      if (!node.ifTrue) messages.push(`Condition "${node.id}" needs an ifTrue branch.`);
      for (const ref of [node.ifTrue, node.ifFalse, node.join]) {
        if (ref && !byId.has(ref)) messages.push(`Condition "${node.id}" references missing node "${ref}".`);
      }
    } else {
      messages.push(`Node "${node.id}": unknown kind "${node.kind}".`);
    }
    if (node.next && !byId.has(node.next)) messages.push(`Node "${node.id}" points to missing node "${node.next}".`);
  }

  // Cycle / reachability check: walk from entry, guard against revisits.
  if (byId.size && graph?.entry && byId.has(graph.entry)) {
    const visited = new Set();
    const walk = (startId, stopId) => {
      let currentId = startId;
      while (currentId && currentId !== stopId) {
        if (visited.has(currentId)) {
          messages.push(`Cycle detected at node "${currentId}".`);
          return;
        }
        visited.add(currentId);
        const node = byId.get(currentId);
        if (!node) return;
        if (node.kind === 'condition') {
          if (node.ifTrue) walk(node.ifTrue, node.join || null);
          if (node.ifFalse) walk(node.ifFalse, node.join || null);
          currentId = node.join || null;
        } else {
          currentId = node.next || null;
        }
      }
    };
    walk(graph.entry, null);
  }

  return messages;
}

// Walks a linear chain (following `next`) from `startId` until `stopId`/null,
// emitting steps. Returns { headIds, tailIds } — the step ids that start and
// end the chain (tails feed the successor's preReq).
function compileChain({ startId, stopId, byId, steps, preReq, condition }) {
  let currentId = startId;
  let entryPre = preReq;
  let entryCondition = condition;
  let tails = preReq;

  while (currentId && currentId !== stopId) {
    const node = byId.get(currentId);
    if (!node) break;

    if (node.kind === 'condition') {
      const conditionSpec = CONDITIONS[node.conditionKey];
      const joinId = node.join || stopId || null;
      const trueBranch = node.ifTrue
        ? compileChain({ startId: node.ifTrue, stopId: joinId, byId, steps, preReq: tails, condition: conditionSpec.key })
        : { tails };
      const falseBranch = node.ifFalse
        ? compileChain({ startId: node.ifFalse, stopId: joinId, byId, steps, preReq: tails, condition: conditionSpec.negation })
        : { tails };
      tails = [...new Set([...(trueBranch.tails || []), ...(falseBranch.tails || [])])];
      entryCondition = null;
      currentId = node.join || null;
      if (node.join && node.join === stopId) break;
      continue;
    }

    const base = {
      id: node.id,
      name: node.name || node.id,
      description: node.description || '',
      preReq: [...(entryPre === tails ? entryPre : tails)],
      ...(entryCondition ? { condition: entryCondition } : {}),
    };
    if (node.kind === 'system') {
      const action = ACTIONS[node.actionKey];
      steps.push({ ...base, actor: action.actor || 'system', taskKey: action.taskKey, actionKey: node.actionKey });
    } else {
      steps.push({
        ...base,
        actor: 'human',
        taskKey: 'human.performActions',
        assigneeEmployeeId: node.assigneeEmployeeId,
        actions: (node.actions || []).map((a) => ({
          id: a.id,
          actionKey: a.actionKey,
          label: a.label || HUMAN_ACTIONS[a.actionKey]?.label || a.actionKey,
          params: a.params || {},
        })),
      });
    }
    tails = [node.id];
    entryCondition = null;
    entryPre = tails;
    currentId = node.next || null;
  }

  return { tails };
}

// compileGraph(graph) -> steps[] in the engine's format. Assumes validateGraph
// passed (throws a 400 otherwise).
export async function compileGraph(graph, trigger) {
  const messages = await validateGraph(graph, trigger);
  if (messages.length) throw httpError(400, 'Workflow validation failed', { messages });

  const byId = new Map((graph.nodes || []).map((node) => [node.id, node]));
  const steps = [];
  compileChain({ startId: graph.entry, stopId: null, byId, steps, preReq: [], condition: null });

  // conditions map for the flowchart renderer (per-key descriptions).
  const conditions = {};
  for (const step of steps) {
    if (step.condition && CONDITIONS[step.condition]) {
      conditions[step.condition] = CONDITIONS[step.condition].description;
      const negation = CONDITIONS[step.condition].negation;
      if (CONDITIONS[negation]) conditions[negation] = CONDITIONS[negation].description;
    }
  }
  return { steps, conditions };
}
