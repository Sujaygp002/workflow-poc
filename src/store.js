// Lightweight localStorage-backed store for POC

const KEYS = {
  workflows: 'wf_workflows',
  tasks: 'wf_tasks',
  actions: 'wf_actions',
  instances: 'wf_instances',
  users: 'wf_users',
  seeded: 'wf_seeded_v10',
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

    // ── Complex workflow 1: Switch condition between tasks ─────────────────
    // Bug Triage Pipeline — after initial triage, a switch routes to different
    // tracks based on bug severity: critical → hotfix track, major → sprint
    // track, minor → backlog track.
    {
      id: 'wf3',
      name: 'Bug Triage Pipeline',
      description: 'Incoming bugs are triaged, then routed via switch to a hotfix, sprint, or backlog track based on severity.',
      owner: 'u2',
      triggerType: 'action',
      triggerConfig: 'bug.reported',
      createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      tasks: [
        {
          id: 'wf3-t1', _instanceId: 'wf3-t1', name: 'Triage & Classify',
          description: 'Engineer reads the bug report and assigns severity',
          executionMode: 'sequential', condition: 'none', conditionExpr: '',
          actions: [
            { id: 'wf3-a1', name: 'Read Bug Report', executorType: 'human', assignedTo: 'u3' },
            { id: 'wf3-a2', name: 'Assign Severity (critical / major / minor)', executorType: 'human', assignedTo: 'u3' },
          ],
        },
        {
          id: 'wf3-t2', _instanceId: 'wf3-t2', name: 'Route by Severity',
          description: 'Switch on severity: critical → hotfix, major → sprint, minor → backlog',
          executionMode: 'sequential', condition: 'switch', conditionExpr: 'severity',
          branches: ['critical → Hotfix Track', 'major → Sprint Track', 'minor → Backlog'],
          actions: [
            { id: 'wf3-a3', name: 'Determine Track (hotfix / sprint / backlog)', executorType: 'human', assignedTo: 'u2' },
          ],
        },
        {
          id: 'wf3-t3', _instanceId: 'wf3-t3', name: 'Hotfix Track — Immediate Fix',
          description: 'Critical severity: engineer produces and deploys a hotfix',
          executionMode: 'parallel', condition: 'none', conditionExpr: '',
          actions: [
            { id: 'wf3-a4', name: 'Develop Hotfix', executorType: 'human', assignedTo: 'u1' },
            { id: 'wf3-a5', name: 'Write Hotfix Test', executorType: 'human', assignedTo: 'u1' },
          ],
        },
        {
          id: 'wf3-t4', _instanceId: 'wf3-t4', name: 'Sprint Track — Schedule & Plan',
          description: 'Major severity: PM schedules the fix into the next sprint',
          executionMode: 'sequential', condition: 'none', conditionExpr: '',
          actions: [
            { id: 'wf3-a6', name: 'Add to Sprint Backlog', executorType: 'human', assignedTo: 'u2' },
            { id: 'wf3-a7', name: 'Assign Developer & Set ETA', executorType: 'human', assignedTo: 'u2' },
          ],
        },
        {
          id: 'wf3-t5', _instanceId: 'wf3-t5', name: 'Review & Close',
          description: 'Verify the fix and close the bug ticket',
          executionMode: 'sequential', condition: 'none', conditionExpr: '',
          actions: [
            { id: 'wf3-a8', name: 'Verify Fix in Staging', executorType: 'human', assignedTo: 'u4' },
            { id: 'wf3-a9', name: 'Close Bug Ticket', executorType: 'human', assignedTo: 'u4' },
          ],
        },
      ],
    },

    // ── Complex workflow 2: Loop condition ─────────────────────────────────
    // Ticket Resolution Batch — agents work tickets one-by-one; after each
    // resolution the loop condition checks whether 8 of 8 tickets are resolved.
    // The loop repeats the "Resolve Ticket" task until the counter reaches 8.
    {
      id: 'wf4',
      name: 'Ticket Resolution Batch',
      description: 'Resolve a batch of 8 support tickets one by one. The resolution task loops until all 8 are done.',
      owner: 'u3',
      triggerType: 'schedule',
      triggerConfig: '0 9 * * MON',
      createdAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      tasks: [
        {
          id: 'wf4-t1', _instanceId: 'wf4-t1', name: 'Load Ticket Batch',
          description: 'Supervisor loads and prioritises the 8 tickets for the shift',
          executionMode: 'sequential', condition: 'none', conditionExpr: '',
          actions: [
            { id: 'wf4-a1', name: 'Pull Open Tickets from Queue', executorType: 'human', assignedTo: 'u2' },
            { id: 'wf4-a2', name: 'Prioritise & Assign to Agents', executorType: 'human', assignedTo: 'u2' },
          ],
        },
        {
          id: 'wf4-t2', _instanceId: 'wf4-t2', name: 'Resolve Ticket',
          description: 'Agent resolves the current ticket then loop checks resolved count',
          executionMode: 'sequential', condition: 'loop', conditionExpr: 'resolvedCount < 8 → repeat',
          branches: ['resolvedCount < 8 → repeat this task', 'resolvedCount === 8 → continue ↓'],
          actions: [
            { id: 'wf4-a3', name: 'Investigate & Diagnose Issue', executorType: 'human', assignedTo: 'u3' },
            { id: 'wf4-a4', name: 'Apply Fix or Workaround', executorType: 'human', assignedTo: 'u3' },
            { id: 'wf4-a5', name: 'Reply to Customer & Confirm Resolution', executorType: 'human', assignedTo: 'u3' },
          ],
        },
        {
          id: 'wf4-t3', _instanceId: 'wf4-t3', name: 'Batch Sign-off',
          description: 'Supervisor reviews all 8 resolutions and signs off the batch',
          executionMode: 'parallel', condition: 'none', conditionExpr: '',
          actions: [
            { id: 'wf4-a6', name: 'Review Resolution Quality (all 8)', executorType: 'human', assignedTo: 'u2' },
            { id: 'wf4-a7', name: 'Update CSAT Report', executorType: 'human', assignedTo: 'u4' },
          ],
        },
        {
          id: 'wf4-t4', _instanceId: 'wf4-t4', name: 'Close Batch',
          description: 'Mark the batch complete and archive tickets',
          executionMode: 'sequential', condition: 'none', conditionExpr: '',
          actions: [
            { id: 'wf4-a8', name: 'Archive Resolved Tickets', executorType: 'human', assignedTo: 'u4' },
            { id: 'wf4-a9', name: 'Send Batch Summary to Team', executorType: 'human', assignedTo: 'u2' },
          ],
        },
      ],
    },

    // ── DEMO workflow: shows IF/ELSE, SWITCH and LOOP in one story ──────────
    // Expense Approval — a single, easy-to-narrate flow that exercises all
    // three conditional types so the branching logic can be demonstrated end
    // to end. Each gate carries human-readable branch labels.
    {
      id: 'wf5',
      name: 'Expense Approval (Conditionals Demo)',
      description: 'A single flow that demonstrates every condition type: an if/else amount gate, a switch on expense category, and a loop that repeats until every receipt is verified.',
      owner: 'u1',
      triggerType: 'action',
      triggerConfig: 'expense.submitted',
      createdAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      tasks: [
        {
          id: 'wf5-t1', _instanceId: 'wf5-t1', name: 'Submit & Validate Expense',
          description: 'Employee submits the expense report and finance validates required fields',
          executionMode: 'sequential', condition: 'none', conditionExpr: '', branches: [],
          actions: [
            { id: 'wf5-a1', name: 'Submit Expense Report', executorType: 'human', assignedTo: 'u1' },
            { id: 'wf5-a2', name: 'Validate Required Fields', executorType: 'human', assignedTo: 'u3' },
          ],
        },
        {
          // IF / ELSE — routes on the claimed amount
          id: 'wf5-t2', _instanceId: 'wf5-t2', name: 'Amount Check',
          description: 'If amount > $1,000 it needs manager approval, else it is auto-approved by finance',
          executionMode: 'sequential', condition: 'if/else', conditionExpr: 'amount > 1000',
          branches: ['if true → Manager Approval (Bob)', 'else → Finance Auto-approve (Dave)'],
          actions: [
            { id: 'wf5-a3', name: 'Evaluate Claimed Amount', executorType: 'human', assignedTo: 'u3' },
          ],
        },
        {
          id: 'wf5-t3', _instanceId: 'wf5-t3', name: 'Manager Approval',
          description: 'High-value path: the employee\'s manager reviews and approves',
          executionMode: 'sequential', condition: 'none', conditionExpr: '', branches: [],
          actions: [
            { id: 'wf5-a4', name: 'Review Expense Detail', executorType: 'human', assignedTo: 'u2' },
            { id: 'wf5-a5', name: 'Approve or Reject', executorType: 'human', assignedTo: 'u2' },
          ],
        },
        {
          // SWITCH — routes on the expense category
          id: 'wf5-t4', _instanceId: 'wf5-t4', name: 'Route by Category',
          description: 'Switch on category: travel → Travel desk, equipment → IT asset desk, meals → Finance',
          executionMode: 'sequential', condition: 'switch', conditionExpr: 'category',
          branches: ['category === "travel" → next task to Dave', 'otherwise → next task to Alice'],
          actions: [
            { id: 'wf5-a6', name: 'Classify Expense Category', executorType: 'human', assignedTo: 'u3' },
            { id: 'wf5-a7', name: 'Forward to Matching Desk', executorType: 'human', assignedTo: 'u3' },
          ],
        },
        {
          // LOOP — repeats until every receipt is verified
          id: 'wf5-t5', _instanceId: 'wf5-t5', name: 'Verify Receipts',
          description: 'Loop: verify each receipt one by one, repeating until all receipts are checked',
          executionMode: 'sequential', condition: 'loop', conditionExpr: 'verified < receipts',
          branches: ['verified < receipts → repeat this task', 'verified === receipts → continue ↓'],
          actions: [
            { id: 'wf5-a8', name: 'Open Next Receipt', executorType: 'human', assignedTo: 'u4' },
            { id: 'wf5-a9', name: 'Match Receipt to Line Item', executorType: 'human', assignedTo: 'u4' },
            { id: 'wf5-a10', name: 'Mark Receipt Verified', executorType: 'human', assignedTo: 'u4' },
          ],
        },
        {
          id: 'wf5-t6', _instanceId: 'wf5-t6', name: 'Reimburse & Close',
          description: 'Finance issues reimbursement and closes the expense report',
          executionMode: 'parallel', condition: 'none', conditionExpr: '', branches: [],
          actions: [
            { id: 'wf5-a11', name: 'Issue Reimbursement', executorType: 'human', assignedTo: 'u3' },
            { id: 'wf5-a12', name: 'Notify Employee', executorType: 'human', assignedTo: 'u1' },
          ],
        },
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
        branches: t.branches || [],
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
