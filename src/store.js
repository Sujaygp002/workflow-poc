// Lightweight localStorage-backed store for POC

const KEYS = {
  workflows: 'wf_workflows',
  tasks: 'wf_tasks',
  actions: 'wf_actions',
  instances: 'wf_instances',
  users: 'wf_users',
  seeded: 'wf_seeded_v7',
};

function load(key) {
  try {
    return JSON.parse(localStorage.getItem(key)) || [];
  } catch {
    return [];
  }
}

function save(key, data) {
  localStorage.setItem(key, JSON.stringify(data));
}

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

// ── Seed Data ──────────────────────────────────────────
function seedIfNeeded() {
  if (localStorage.getItem(KEYS.seeded)) return;
  // clear all stale data from any previous seed
  save(KEYS.instances, []);
  save(KEYS.workflows, []);
  save(KEYS.tasks, []);
  save(KEYS.actions, []);
  save(KEYS.users, []);

  const users = [
    { id: 'u1', name: 'Alice' },
    { id: 'u2', name: 'Bob' },
    { id: 'u3', name: 'Carol' },
    { id: 'u4', name: 'Dave' },
  ];

  const actions = [
    { id: 'a1', name: 'Read & Annotate Contract', description: 'Reviewer reads and annotates the contract document', executorType: 'human', assignedTo: 'u1' },
    { id: 'a2', name: 'Check Compliance Clauses', description: 'Verify all compliance clauses are met', executorType: 'human', assignedTo: 'u3' },
    { id: 'a3', name: 'Approve Contract', description: 'Manager approves the reviewed contract', executorType: 'human', assignedTo: 'u2' },
    { id: 'a4', name: 'Counter-sign Document', description: 'Senior manager counter-signs the contract', executorType: 'human', assignedTo: 'u4' },
    { id: 'a5', name: 'File in Document System', description: 'File the signed contract in the document system', executorType: 'human', assignedTo: 'u3' },
    { id: 'a6', name: 'Notify Sales Rep', description: 'Notify the sales rep that the contract is signed', executorType: 'human', assignedTo: 'u1' },
    { id: 'a7', name: 'Read & Categorise Ticket', description: 'Support agent reads and categorises the ticket', executorType: 'human', assignedTo: 'u3' },
    { id: 'a8', name: 'Assign Severity Level', description: 'Assign a severity level to the ticket', executorType: 'human', assignedTo: 'u3' },
    { id: 'a9', name: 'Reproduce Issue', description: 'Engineer reproduces the reported issue', executorType: 'human', assignedTo: 'u1' },
    { id: 'a10', name: 'Write Root Cause Analysis', description: 'Document the root cause of the issue', executorType: 'human', assignedTo: 'u1' },
    { id: 'a11', name: 'Apply Fix / Workaround', description: 'Apply the fix or workaround', executorType: 'human', assignedTo: 'u2' },
    { id: 'a12', name: 'Notify Customer', description: 'Notify the customer of the resolution', executorType: 'human', assignedTo: 'u3' },
    { id: 'a13', name: 'Close Ticket', description: 'Mark the ticket as closed', executorType: 'human', assignedTo: 'u4' },
  ];

  const tasks = [
    {
      id: 't1', name: 'Initial Review', description: 'Reviewer reads and annotates the contract',
      executionMode: 'sequential', condition: 'none', conditionExpr: '',
      actions: [{ ...actions[0] }, { ...actions[1] }],
    },
    {
      id: 't2', name: 'Manager Sign-off', description: 'Manager and senior manager both sign off in parallel',
      executionMode: 'parallel', condition: 'none', conditionExpr: '',
      actions: [{ ...actions[2] }, { ...actions[3] }],
    },
    {
      id: 't3', name: 'File & Notify', description: 'File the contract and notify the sales rep',
      executionMode: 'sequential', condition: 'none', conditionExpr: '',
      actions: [{ ...actions[4] }, { ...actions[5] }],
    },
    {
      id: 't4', name: 'Triage', description: 'Support agent reads and categorises the ticket',
      executionMode: 'sequential', condition: 'none', conditionExpr: '',
      actions: [{ ...actions[6] }, { ...actions[7] }],
    },
    {
      id: 't5', name: 'Investigation', description: 'Engineer investigates root cause in parallel',
      executionMode: 'parallel', condition: 'if/else', conditionExpr: 'severity === "critical"',
      actions: [{ ...actions[8] }, { ...actions[9] }],
    },
    {
      id: 't6', name: 'Resolution & Close', description: 'Fix applied, customer notified, ticket closed',
      executionMode: 'sequential', condition: 'none', conditionExpr: '',
      actions: [{ ...actions[10] }, { ...actions[11] }, { ...actions[12] }],
    },
  ];

  const workflows = [
    {
      id: 'wf1',
      name: 'Contract Review',
      description: 'Legal team reviews and countersigns contracts submitted by sales. Fully human-driven.',
      owner: 'u1',
      triggerType: 'click',
      triggerConfig: '',
      createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      tasks: [
        { ...tasks[0], _instanceId: 'wf1-t1' },
        { ...tasks[1], _instanceId: 'wf1-t2' },
        { ...tasks[2], _instanceId: 'wf1-t3' },
      ],
    },
    {
      id: 'wf2',
      name: 'Support Ticket Escalation',
      description: 'Escalate and resolve a high-priority customer support ticket end-to-end by humans.',
      owner: 'u2',
      triggerType: 'action',
      triggerConfig: 'ticket.priority_high',
      createdAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(),
      tasks: [
        { ...tasks[3], _instanceId: 'wf2-t1' },
        { ...tasks[4], _instanceId: 'wf2-t2' },
        { ...tasks[5], _instanceId: 'wf2-t3' },
      ],
    },
  ];

  save(KEYS.users, users);
  save(KEYS.actions, actions);
  save(KEYS.tasks, tasks);
  save(KEYS.workflows, workflows);
  save(KEYS.instances, []);
  localStorage.setItem(KEYS.seeded, '1');
}

// ── Users ──────────────────────────────────────────────
export function getUsers() {
  seedIfNeeded();
  return load(KEYS.users);
}

// ── Actions ────────────────────────────────────────────
export function getActions() {
  seedIfNeeded();
  return load(KEYS.actions);
}

export function saveAction(action) {
  const list = load(KEYS.actions);
  if (action.id) {
    const idx = list.findIndex(a => a.id === action.id);
    if (idx >= 0) { list[idx] = action; } else { list.push(action); }
  } else {
    list.push({ ...action, id: uid() });
  }
  save(KEYS.actions, list);
  return list;
}

export function deleteAction(id) {
  save(KEYS.actions, load(KEYS.actions).filter(a => a.id !== id));
}

// ── Tasks ──────────────────────────────────────────────
export function getTasks() {
  seedIfNeeded();
  return load(KEYS.tasks);
}

export function saveTask(task) {
  const list = load(KEYS.tasks);
  if (task.id) {
    const idx = list.findIndex(t => t.id === task.id);
    if (idx >= 0) { list[idx] = task; } else { list.push(task); }
  } else {
    list.push({ ...task, id: uid() });
  }
  save(KEYS.tasks, list);
  return list;
}

export function deleteTask(id) {
  save(KEYS.tasks, load(KEYS.tasks).filter(t => t.id !== id));
}

// ── Workflows ──────────────────────────────────────────
export function getWorkflows() {
  seedIfNeeded();
  return load(KEYS.workflows);
}

export function saveWorkflow(wf) {
  const list = load(KEYS.workflows);
  if (wf.id) {
    const idx = list.findIndex(w => w.id === wf.id);
    if (idx >= 0) { list[idx] = wf; } else { list.push(wf); }
  } else {
    list.push({ ...wf, id: uid(), createdAt: new Date().toISOString() });
  }
  save(KEYS.workflows, list);
  return list;
}

export function deleteWorkflow(id) {
  save(KEYS.workflows, load(KEYS.workflows).filter(w => w.id !== id));
}

// ── Instances (launched workflows) ────────────────────
export function getInstances() { return load(KEYS.instances); }

// ── Execution helpers ──────────────────────────────────

// For a task instance, activate the correct actions based on executionMode:
//   sequential → only the first non-completed, non-blocked action becomes 'active'
//   parallel   → all non-completed actions become 'active'
function activateTask(ti) {
  const mode = ti.executionMode || 'sequential';
  if (mode === 'parallel') {
    ti.actionInstances.forEach(a => {
      if (a.status === 'blocked') a.status = 'active';
    });
  } else {
    // sequential: activate only the first blocked/pending action
    let activated = false;
    for (const a of ti.actionInstances) {
      if (a.status === 'completed' || a.status === 'active') {
        if (a.status === 'active') activated = true; // already one active, stop
        continue;
      }
      if (!activated && (a.status === 'blocked' || a.status === 'pending')) {
        a.status = 'active';
        activated = true;
      }
      break;
    }
  }
}

export function launchWorkflow(workflowId) {
  const wf = load(KEYS.workflows).find(w => w.id === workflowId);
  if (!wf) return null;

  const now = new Date();

  const instance = {
    id: uid(),
    workflowId,
    workflowName: wf.name,
    launchedAt: now.toISOString(),
    status: 'running',
    taskInstances: (wf.tasks || []).map((t, tIdx) => {
      const execMode = t.executionMode || 'sequential';
      const actionInstances = (t.actions || []).map((a, aIdx) => {
        const isAuto = a.executorType === 'ai' || a.executorType === 'system' || a.executorType === 'ai+system';
        // In sequential mode: first action is active, rest blocked. In parallel: all active.
        // Auto actions are immediately completed regardless.
        let status = 'blocked';
        if (isAuto) status = 'completed';
        else if (execMode === 'parallel') status = 'active';
        else if (aIdx === 0) status = 'active';

        return {
          id: uid(),
          actionId: a.id,
          actionName: a.name,
          assignedTo: a.assignedTo,
          executorType: a.executorType || 'human',
          status,
          completedAt: isAuto ? new Date(now.getTime() + 500).toISOString() : null,
          notes: isAuto ? `Auto-executed by ${a.executorType}` : '',
          autoRun: isAuto,
          order: aIdx,
        };
      });

      // After auto-runs, re-activate sequential chain in case first action(s) were auto
      const ti = {
        id: uid(),
        taskId: t.id,
        taskName: t.name,
        condition: t.condition || 'none',
        conditionExpr: t.conditionExpr || '',
        executionMode: execMode,
        status: 'pending',
        actionInstances,
      };
      activateTask(ti);

      const allDone = ti.actionInstances.every(a => a.status === 'completed');
      if (allDone) ti.status = 'completed';
      return ti;
    }),
  };

  if (instance.taskInstances.every(t => t.status === 'completed')) {
    instance.status = 'completed';
  }

  const list = load(KEYS.instances);
  list.push(instance);
  save(KEYS.instances, list);
  return instance;
}

export function completeActionInstance(instanceId, taskInstanceId, actionInstanceId, notes) {
  const list = load(KEYS.instances);
  const inst = list.find(i => i.id === instanceId);
  if (!inst) return;

  const ti = inst.taskInstances.find(t => t.id === taskInstanceId);
  if (!ti) return;

  const ai = ti.actionInstances.find(a => a.id === actionInstanceId);
  if (!ai) return;

  ai.status = 'completed';
  ai.completedAt = new Date().toISOString();
  ai.notes = notes;

  // In sequential mode: unlock the next action
  if ((ti.executionMode || 'sequential') === 'sequential') {
    const next = ti.actionInstances.find(a => a.status === 'blocked');
    if (next) next.status = 'active';
  }

  if (ti.actionInstances.every(a => a.status === 'completed')) {
    ti.status = 'completed';
  }

  if (inst.taskInstances.every(t => t.status === 'completed')) {
    inst.status = 'completed';
  }

  save(KEYS.instances, list);
  return list;
}

export function getMyWorkItems(userId) {
  const instances = load(KEYS.instances).filter(i => i.status === 'running');
  const items = [];

  for (const inst of instances) {
    for (const ti of inst.taskInstances) {
      for (const ai of ti.actionInstances) {
        // only show actions that are 'active' — not blocked, not completed
        if (ai.assignedTo === userId && ai.status === 'active') {
          items.push({
            instanceId: inst.id,
            workflowName: inst.workflowName,
            launchedAt: inst.launchedAt,
            taskInstanceId: ti.id,
            taskName: ti.taskName,
            actionInstanceId: ai.id,
            actionName: ai.actionName,
            executorType: ai.executorType,
            executionMode: ti.executionMode,
            status: ai.status,
          });
        }
      }
    }
  }

  return items;
}

export function getMyCompletedItems(userId) {
  const instances = load(KEYS.instances);
  const items = [];

  for (const inst of instances) {
    for (const ti of inst.taskInstances) {
      for (const ai of ti.actionInstances) {
        if (ai.assignedTo === userId && ai.status === 'completed' && !ai.autoRun) {
          items.push({
            instanceId: inst.id,
            workflowName: inst.workflowName,
            taskInstanceId: ti.id,
            taskName: ti.taskName,
            actionInstanceId: ai.id,
            actionName: ai.actionName,
            completedAt: ai.completedAt,
            notes: ai.notes,
          });
        }
      }
    }
  }

  return items.sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt));
}
