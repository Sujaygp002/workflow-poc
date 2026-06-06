// Lightweight localStorage-backed store for POC

const KEYS = {
  workflows: 'wf_workflows',
  tasks: 'wf_tasks',
  actions: 'wf_actions',
  instances: 'wf_instances',
  users: 'wf_users',
  seeded: 'wf_seeded_v11',
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

  // Workflow schema:
  // {
  //   id, name, description,
  //   trigger: 'click|schedule|action|task|workflow',
  //   triggerConfig: '...',
  //   createdAt,
  //   tasks: [
  //     {
  //       id, name, description,
  //       PreReq: 'none' | ['taskId', ...],
  //       condition: 'none|if/else|switch|loop',
  //       conditionExpr: '...',
  //       branches: ['label → dest', ...],
  //       Tasksteps: ['action name', ...]   // display labels
  //       actions: [{ id, name, executorType }]  // runtime
  //     }
  //   ]
  // }

  const workflows = [
    {
      id: 'wf1',
      name: 'Contract Review',
      description: 'Legal team reviews and countersigns contracts submitted by sales.',
      trigger: 'click',
      triggerConfig: '',
      createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      tasks: [
        {
          id: 'wf1-t1', name: 'Initial Review',
          description: 'Reviewer reads and annotates the contract',
          PreReq: 'none', condition: 'none', conditionExpr: '', branches: [],
          Tasksteps: ['Read & Annotate Contract', 'Check Compliance Clauses'],
          actions: [
            { id: 'wf1-a1', name: 'Read & Annotate Contract', executorType: 'human' },
            { id: 'wf1-a2', name: 'Check Compliance Clauses', executorType: 'human' },
          ],
        },
        {
          id: 'wf1-t2', name: 'Manager Sign-off',
          description: 'Manager and senior manager both sign off',
          PreReq: ['wf1-t1'], condition: 'none', conditionExpr: '', branches: [],
          Tasksteps: ['Approve Contract', 'Counter-sign Document'],
          actions: [
            { id: 'wf1-a3', name: 'Approve Contract', executorType: 'human' },
            { id: 'wf1-a4', name: 'Counter-sign Document', executorType: 'human' },
          ],
        },
        {
          id: 'wf1-t3', name: 'File & Notify',
          description: 'File the contract and notify the sales rep',
          PreReq: ['wf1-t2'], condition: 'none', conditionExpr: '', branches: [],
          Tasksteps: ['File in Document System', 'Notify Sales Rep'],
          actions: [
            { id: 'wf1-a5', name: 'File in Document System', executorType: 'human' },
            { id: 'wf1-a6', name: 'Notify Sales Rep', executorType: 'human' },
          ],
        },
      ],
    },

    {
      id: 'wf2',
      name: 'Support Ticket Escalation',
      description: 'Escalate and resolve a high-priority customer support ticket end-to-end.',
      trigger: 'action',
      triggerConfig: 'ticket.priority_high',
      createdAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(),
      tasks: [
        {
          id: 'wf2-t1', name: 'Triage',
          description: 'Support agent reads and categorises the ticket',
          PreReq: 'none', condition: 'none', conditionExpr: '', branches: [],
          Tasksteps: ['Read & Categorise Ticket', 'Assign Severity Level'],
          actions: [
            { id: 'wf2-a1', name: 'Read & Categorise Ticket', executorType: 'human' },
            { id: 'wf2-a2', name: 'Assign Severity Level', executorType: 'human' },
          ],
        },
        {
          id: 'wf2-t2', name: 'Investigation',
          description: 'Engineer investigates root cause',
          PreReq: ['wf2-t1'], condition: 'if/else', conditionExpr: 'severity === "critical"',
          branches: ['true → escalate to senior eng', 'else → standard investigation'],
          Tasksteps: ['Reproduce Issue', 'Write Root Cause Analysis'],
          actions: [
            { id: 'wf2-a3', name: 'Reproduce Issue', executorType: 'human' },
            { id: 'wf2-a4', name: 'Write Root Cause Analysis', executorType: 'human' },
          ],
        },
        {
          id: 'wf2-t3', name: 'Resolution & Close',
          description: 'Fix applied, customer notified, ticket closed',
          PreReq: ['wf2-t2'], condition: 'none', conditionExpr: '', branches: [],
          Tasksteps: ['Apply Fix / Workaround', 'Notify Customer', 'Close Ticket'],
          actions: [
            { id: 'wf2-a5', name: 'Apply Fix / Workaround', executorType: 'human' },
            { id: 'wf2-a6', name: 'Notify Customer', executorType: 'human' },
            { id: 'wf2-a7', name: 'Close Ticket', executorType: 'human' },
          ],
        },
      ],
    },

    {
      id: 'wf3',
      name: 'Bug Triage Pipeline',
      description: 'Incoming bugs are triaged, then routed via switch to a hotfix, sprint, or backlog track based on severity.',
      trigger: 'action',
      triggerConfig: 'bug.reported',
      createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      tasks: [
        {
          id: 'wf3-t1', name: 'Triage & Classify',
          description: 'Engineer reads the bug report and assigns severity',
          PreReq: 'none', condition: 'none', conditionExpr: '', branches: [],
          Tasksteps: ['Read Bug Report', 'Assign Severity (critical / major / minor)'],
          actions: [
            { id: 'wf3-a1', name: 'Read Bug Report', executorType: 'human' },
            { id: 'wf3-a2', name: 'Assign Severity (critical / major / minor)', executorType: 'human' },
          ],
        },
        {
          id: 'wf3-t2', name: 'Route by Severity',
          description: 'Switch on severity: critical → hotfix, major → sprint, minor → backlog',
          PreReq: ['wf3-t1'], condition: 'switch', conditionExpr: 'severity',
          branches: ['critical → Hotfix Track', 'major → Sprint Track', 'minor → Backlog'],
          Tasksteps: ['Determine Track (hotfix / sprint / backlog)'],
          actions: [
            { id: 'wf3-a3', name: 'Determine Track (hotfix / sprint / backlog)', executorType: 'human' },
          ],
        },
        {
          id: 'wf3-t3', name: 'Hotfix Track — Immediate Fix',
          description: 'Critical severity: engineer produces and deploys a hotfix',
          PreReq: ['wf3-t2'], condition: 'none', conditionExpr: '', branches: [],
          Tasksteps: ['Develop Hotfix', 'Write Hotfix Test'],
          actions: [
            { id: 'wf3-a4', name: 'Develop Hotfix', executorType: 'human' },
            { id: 'wf3-a5', name: 'Write Hotfix Test', executorType: 'human' },
          ],
        },
        {
          id: 'wf3-t4', name: 'Sprint Track — Schedule & Plan',
          description: 'Major severity: PM schedules the fix into the next sprint',
          PreReq: ['wf3-t2'], condition: 'none', conditionExpr: '', branches: [],
          Tasksteps: ['Add to Sprint Backlog', 'Assign Developer & Set ETA'],
          actions: [
            { id: 'wf3-a6', name: 'Add to Sprint Backlog', executorType: 'human' },
            { id: 'wf3-a7', name: 'Assign Developer & Set ETA', executorType: 'human' },
          ],
        },
        {
          id: 'wf3-t5', name: 'Review & Close',
          description: 'Verify the fix and close the bug ticket',
          PreReq: ['wf3-t3', 'wf3-t4'], condition: 'none', conditionExpr: '', branches: [],
          Tasksteps: ['Verify Fix in Staging', 'Close Bug Ticket'],
          actions: [
            { id: 'wf3-a8', name: 'Verify Fix in Staging', executorType: 'human' },
            { id: 'wf3-a9', name: 'Close Bug Ticket', executorType: 'human' },
          ],
        },
      ],
    },

    {
      id: 'wf4',
      name: 'Ticket Resolution Batch',
      description: 'Resolve a batch of 8 support tickets one by one. The resolution task loops until all 8 are done.',
      trigger: 'schedule',
      triggerConfig: '0 9 * * MON',
      createdAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      tasks: [
        {
          id: 'wf4-t1', name: 'Load Ticket Batch',
          description: 'Supervisor loads and prioritises the 8 tickets for the shift',
          PreReq: 'none', condition: 'none', conditionExpr: '', branches: [],
          Tasksteps: ['Pull Open Tickets from Queue', 'Prioritise & Assign to Agents'],
          actions: [
            { id: 'wf4-a1', name: 'Pull Open Tickets from Queue', executorType: 'human' },
            { id: 'wf4-a2', name: 'Prioritise & Assign to Agents', executorType: 'human' },
          ],
        },
        {
          id: 'wf4-t2', name: 'Resolve Ticket',
          description: 'Agent resolves the current ticket; loop repeats until resolvedCount reaches 8',
          PreReq: ['wf4-t1'], condition: 'loop', conditionExpr: 'resolvedCount < 8 → repeat',
          branches: ['resolvedCount < 8 → repeat this task', 'resolvedCount === 8 → continue ↓'],
          Tasksteps: ['Investigate & Diagnose Issue', 'Apply Fix or Workaround', 'Reply to Customer & Confirm Resolution'],
          actions: [
            { id: 'wf4-a3', name: 'Investigate & Diagnose Issue', executorType: 'human' },
            { id: 'wf4-a4', name: 'Apply Fix or Workaround', executorType: 'human' },
            { id: 'wf4-a5', name: 'Reply to Customer & Confirm Resolution', executorType: 'human' },
          ],
        },
        {
          id: 'wf4-t3', name: 'Batch Sign-off',
          description: 'Supervisor reviews all 8 resolutions and signs off the batch',
          PreReq: ['wf4-t2'], condition: 'none', conditionExpr: '', branches: [],
          Tasksteps: ['Review Resolution Quality (all 8)', 'Update CSAT Report'],
          actions: [
            { id: 'wf4-a6', name: 'Review Resolution Quality (all 8)', executorType: 'human' },
            { id: 'wf4-a7', name: 'Update CSAT Report', executorType: 'human' },
          ],
        },
        {
          id: 'wf4-t4', name: 'Close Batch',
          description: 'Mark the batch complete and archive tickets',
          PreReq: ['wf4-t3'], condition: 'none', conditionExpr: '', branches: [],
          Tasksteps: ['Archive Resolved Tickets', 'Send Batch Summary to Team'],
          actions: [
            { id: 'wf4-a8', name: 'Archive Resolved Tickets', executorType: 'human' },
            { id: 'wf4-a9', name: 'Send Batch Summary to Team', executorType: 'human' },
          ],
        },
      ],
    },

    {
      id: 'wf5',
      name: 'Expense Approval (Conditionals Demo)',
      description: 'Demonstrates every condition type: if/else on amount, switch on category, loop until all receipts verified.',
      trigger: 'action',
      triggerConfig: 'expense.submitted',
      createdAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      tasks: [
        {
          id: 'wf5-t1', name: 'Submit & Validate Expense',
          description: 'Employee submits the expense report and finance validates required fields',
          PreReq: 'none', condition: 'none', conditionExpr: '', branches: [],
          Tasksteps: ['Submit Expense Report', 'Validate Required Fields'],
          actions: [
            { id: 'wf5-a1', name: 'Submit Expense Report', executorType: 'human' },
            { id: 'wf5-a2', name: 'Validate Required Fields', executorType: 'human' },
          ],
        },
        {
          id: 'wf5-t2', name: 'Amount Check',
          description: 'If amount > $1,000 → Manager Approval (Bob), else → Finance Auto-approve (Dave)',
          PreReq: ['wf5-t1'], condition: 'if/else', conditionExpr: 'amount > 1000',
          branches: ['if true → Manager Approval (Bob)', 'else → Finance Auto-approve (Dave)'],
          Tasksteps: ['Evaluate Claimed Amount'],
          actions: [
            { id: 'wf5-a3', name: 'Evaluate Claimed Amount', executorType: 'human' },
          ],
        },
        {
          id: 'wf5-t3', name: 'Manager Approval',
          description: 'High-value path: the manager reviews and approves',
          PreReq: ['wf5-t2'], condition: 'none', conditionExpr: '', branches: [],
          Tasksteps: ['Review Expense Detail', 'Approve or Reject'],
          actions: [
            { id: 'wf5-a4', name: 'Review Expense Detail', executorType: 'human' },
            { id: 'wf5-a5', name: 'Approve or Reject', executorType: 'human' },
          ],
        },
        {
          id: 'wf5-t4', name: 'Route by Category',
          description: 'Switch on category: "travel" → next task to Dave, otherwise → Alice',
          PreReq: ['wf5-t3'], condition: 'switch', conditionExpr: 'category',
          branches: ['category === "travel" → next task to Dave', 'otherwise → next task to Alice'],
          Tasksteps: ['Classify Expense Category', 'Forward to Matching Desk'],
          actions: [
            { id: 'wf5-a6', name: 'Classify Expense Category', executorType: 'human' },
            { id: 'wf5-a7', name: 'Forward to Matching Desk', executorType: 'human' },
          ],
        },
        {
          id: 'wf5-t5', name: 'Verify Receipts',
          description: 'Loop: verify each receipt one by one, repeating until all are checked',
          PreReq: ['wf5-t4'], condition: 'loop', conditionExpr: 'verified < receipts',
          branches: ['verified < receipts → repeat this task', 'verified === receipts → continue ↓'],
          Tasksteps: ['Open Next Receipt', 'Match Receipt to Line Item', 'Mark Receipt Verified'],
          actions: [
            { id: 'wf5-a8', name: 'Open Next Receipt', executorType: 'human' },
            { id: 'wf5-a9', name: 'Match Receipt to Line Item', executorType: 'human' },
            { id: 'wf5-a10', name: 'Mark Receipt Verified', executorType: 'human' },
          ],
        },
        {
          id: 'wf5-t6', name: 'Reimburse & Close',
          description: 'Finance issues reimbursement and closes the expense report',
          PreReq: ['wf5-t5'], condition: 'none', conditionExpr: '', branches: [],
          Tasksteps: ['Issue Reimbursement', 'Notify Employee'],
          actions: [
            { id: 'wf5-a11', name: 'Issue Reimbursement', executorType: 'human' },
            { id: 'wf5-a12', name: 'Notify Employee', executorType: 'human' },
          ],
        },
      ],
    },
  ];

  save(KEYS.users, users);
  save(KEYS.actions, []);
  save(KEYS.tasks, []);
  save(KEYS.workflows, workflows);
  save(KEYS.instances, []);
  localStorage.setItem(KEYS.seeded, '1');
}

// ── Users ──────────────────────────────────────────────
export function getUsers() {
  seedIfNeeded();
  return load(KEYS.users);
}

// ── Actions (registry — kept for builder compatibility) ─
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

// ── Tasks (registry) ───────────────────────────────────
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

function activateTask(ti) {
  // all actions start active (no sequential blocking — execution mode removed)
  ti.actionInstances.forEach(a => {
    if (a.status === 'blocked') a.status = 'active';
  });
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
      const actionInstances = (t.actions || []).map((a, aIdx) => ({
        id: uid(),
        actionId: a.id,
        actionName: a.name,
        executorType: a.executorType || 'human',
        // first task's first action is active; rest active too (no sequential mode)
        status: tIdx === 0 ? 'active' : 'blocked',
        completedAt: null,
        notes: '',
        order: aIdx,
      }));

      const ti = {
        id: uid(),
        taskId: t.id,
        taskName: t.name,
        condition: t.condition || 'none',
        conditionExpr: t.conditionExpr || '',
        branches: t.branches || [],
        PreReq: t.PreReq || 'none',
        Tasksteps: t.Tasksteps || [],
        status: tIdx === 0 ? 'active' : 'pending',
        actionInstances,
      };

      if (tIdx === 0) activateTask(ti);

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

  if (ti.actionInstances.every(a => a.status === 'completed')) {
    ti.status = 'completed';
    // unlock the next pending task
    const nextTask = inst.taskInstances.find(t => t.status === 'pending');
    if (nextTask) {
      nextTask.status = 'active';
      activateTask(nextTask);
    }
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
