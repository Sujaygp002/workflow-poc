// Lightweight localStorage-backed store for POC
//
// MVP model (per boss notes): keep it intentionally simple.
//  - A small, hardcoded set of TRIGGERS. Each trigger maps to one workflow.
//  - A workflow has a name + description and a list of STEPS.
//  - A step is exactly one of three types: 'task' | 'conditional' | 'loop'.
//  - Tasks have no execution mode (parallel by default); sequencing is via PreReq.
//  - No actions / owners at the workflow level. The orchestrator auto-assigns
//    people when a workflow is launched (no manual Dispatcher).
//  - A minimal, set-based object model: MSA, PG, HHS. Loops run over a set.

const KEYS = {
  workflows: 'wf_workflows',
  instances: 'wf_instances',
  users: 'wf_users',
  seeded: 'wf_seeded_v12',
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

// ── Predefined object-model sets ───────────────────────
// Set-based object model. Loops / for-each operate over one of these.
export const OBJECT_SETS = [
  { id: 'MSA', name: 'MSA', label: 'Metropolitan Statistical Areas', size: 6 },
  { id: 'PG',  name: 'PG',  label: 'Provider Groups',                  size: 4 },
  { id: 'HHS', name: 'HHS', label: 'Home Health Services',            size: 8 },
];

export function getObjectSets() {
  return OBJECT_SETS;
}

// ── Predefined triggers ────────────────────────────────
// A small, hardcoded set of triggers for the MVP. Each trigger corresponds to
// a workflow (workflowId). Triggers whose workflowId has no matching workflow
// are the "unmapped" ones the user is meant to set up first.
export const TRIGGERS = [
  { id: 'trigger-1', name: 'Trigger 1', label: 'Call Doctor',        description: 'A patient requests a doctor call-back.',          workflowId: 'wf1' },
  { id: 'trigger-2', name: 'Trigger 2', label: 'New Patient Intake', description: 'A new patient is registered in the system.',       workflowId: 'wf2' },
  { id: 'trigger-3', name: 'Trigger 3', label: 'Claim Submitted',    description: 'An insurance claim is filed for review.',          workflowId: 'wf3' },
  { id: 'trigger-4', name: 'Trigger 4', label: 'Episode Review',     description: 'A care episode is flagged for batch review.',      workflowId: 'wf4' },
  { id: 'trigger-5', name: 'Trigger 5', label: 'Expense Submitted',  description: 'An expense report is submitted for approval.',     workflowId: 'wf5' },
  { id: 'trigger-6', name: 'Trigger 6', label: 'Discharge Planning', description: 'A patient is scheduled for discharge.',            workflowId: null },
  { id: 'trigger-7', name: 'Trigger 7', label: 'Lab Result Ready',   description: 'A lab result is returned and needs routing.',      workflowId: null },
];

export function getTriggers() {
  seedIfNeeded();
  return TRIGGERS;
}

// Triggers that do not yet have a workflow — the primary ones to set up.
export function getUnmappedTriggers() {
  const wfs = getWorkflows();
  return TRIGGERS.filter(t => !t.workflowId || !wfs.find(w => w.id === t.workflowId));
}

// ── Seed Data ──────────────────────────────────────────
// Step schema:
//   { id, type: 'task'|'conditional'|'loop', name, description,
//     PreReq: 'none' | ['stepId', ...],
//     // conditional only:
//     condition: 'if/else'|'switch', conditionExpr, branches: ['label → dest']
//     // loop only:
//     loopSet: 'MSA'|'PG'|'HHS', loopExpr,
//     Tasksteps: ['sub-step label', ...]   // display only
//   }
function seedIfNeeded() {
  if (localStorage.getItem(KEYS.seeded)) return;

  const users = [
    { id: 'u1', name: 'Alice' },
    { id: 'u2', name: 'Bob' },
    { id: 'u3', name: 'Carol' },
    { id: 'u4', name: 'Dave' },
  ];

  const workflows = [
    {
      id: 'wf1',
      name: 'Call Doctor',
      description: 'Route a patient call-back request to the right doctor and confirm the call.',
      triggerId: 'trigger-1',
      createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      steps: [
        {
          id: 'wf1-s1', type: 'task', name: 'Log Call Request',
          description: 'Front desk records the patient request and reason for the call.',
          PreReq: 'none',
          Tasksteps: ['Capture Patient Details', 'Record Reason for Call'],
        },
        {
          id: 'wf1-s2', type: 'conditional', name: 'Urgency Check',
          description: 'Decide routing based on how urgent the request is.',
          PreReq: ['wf1-s1'],
          condition: 'if/else', conditionExpr: 'urgency === "high"',
          branches: ['if true → On-call Doctor (Bob)', 'else → Scheduled Doctor (Carol)'],
          Tasksteps: ['Assess Urgency'],
        },
        {
          id: 'wf1-s3', type: 'task', name: 'Doctor Call-back',
          description: 'The assigned doctor calls the patient back.',
          PreReq: ['wf1-s2'],
          Tasksteps: ['Review Patient History', 'Call Patient', 'Log Outcome'],
        },
      ],
    },

    {
      id: 'wf2',
      name: 'New Patient Intake',
      description: 'Register a new patient, verify insurance, and create their record.',
      triggerId: 'trigger-2',
      createdAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(),
      steps: [
        {
          id: 'wf2-s1', type: 'task', name: 'Collect Intake Form',
          description: 'Gather the patient demographics and history.',
          PreReq: 'none',
          Tasksteps: ['Collect Demographics', 'Collect Medical History'],
        },
        {
          id: 'wf2-s2', type: 'conditional', name: 'Insurance Check',
          description: 'Route based on whether insurance is on file.',
          PreReq: ['wf2-s1'],
          condition: 'if/else', conditionExpr: 'hasInsurance === true',
          branches: ['if true → Verify Coverage (Dave)', 'else → Self-pay Setup (Alice)'],
          Tasksteps: ['Check Insurance on File'],
        },
        {
          id: 'wf2-s3', type: 'task', name: 'Create Patient Record',
          description: 'Create the chart and notify the care team.',
          PreReq: ['wf2-s2'],
          Tasksteps: ['Create Chart', 'Notify Care Team'],
        },
      ],
    },

    {
      id: 'wf3',
      name: 'Claim Review',
      description: 'Triage a submitted claim and route it by type to the right desk.',
      triggerId: 'trigger-3',
      createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      steps: [
        {
          id: 'wf3-s1', type: 'task', name: 'Validate Claim',
          description: 'Check the claim for completeness and required fields.',
          PreReq: 'none',
          Tasksteps: ['Check Required Fields', 'Assign Claim Type'],
        },
        {
          id: 'wf3-s2', type: 'conditional', name: 'Route by Claim Type',
          description: 'Switch on claim type to the matching desk.',
          PreReq: ['wf3-s1'],
          condition: 'switch', conditionExpr: 'claimType',
          branches: ['inpatient → Inpatient Desk (Bob)', 'outpatient → Outpatient Desk (Carol)', 'pharmacy → Pharmacy Desk (Dave)'],
          Tasksteps: ['Determine Desk'],
        },
        {
          id: 'wf3-s3', type: 'task', name: 'Adjudicate Claim',
          description: 'The assigned desk reviews and decides the claim.',
          PreReq: ['wf3-s2'],
          Tasksteps: ['Review Documentation', 'Approve or Deny'],
        },
        {
          id: 'wf3-s4', type: 'task', name: 'Notify & Close',
          description: 'Notify the provider of the decision and close the claim.',
          PreReq: ['wf3-s3'],
          Tasksteps: ['Send Decision Letter', 'Close Claim'],
        },
      ],
    },

    {
      id: 'wf4',
      name: 'Episode Review (for-each)',
      description: 'Review every care episode in a Home Health Services batch, one by one.',
      triggerId: 'trigger-4',
      createdAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      steps: [
        {
          id: 'wf4-s1', type: 'task', name: 'Load Episode Batch',
          description: 'Pull the set of episodes due for review this cycle.',
          PreReq: 'none',
          Tasksteps: ['Pull Open Episodes', 'Prioritise Queue'],
        },
        {
          id: 'wf4-s2', type: 'loop', name: 'Review Each Episode',
          description: 'For each episode in the HHS set, review and sign off.',
          PreReq: ['wf4-s1'],
          loopSet: 'HHS', loopExpr: 'for each episode in HHS',
          Tasksteps: ['Open Episode', 'Verify Documentation', 'Sign Off Episode'],
        },
        {
          id: 'wf4-s3', type: 'task', name: 'Close Batch',
          description: 'Summarise the reviewed batch and archive it.',
          PreReq: ['wf4-s2'],
          Tasksteps: ['Compile Summary', 'Archive Batch'],
        },
      ],
    },

    {
      id: 'wf5',
      name: 'Expense Approval (Conditionals Demo)',
      description: 'Demonstrates all step types: if/else on amount, switch on category, loop over receipts.',
      triggerId: 'trigger-5',
      createdAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      steps: [
        {
          id: 'wf5-s1', type: 'task', name: 'Submit & Validate Expense',
          description: 'Employee submits the report and finance validates required fields.',
          PreReq: 'none',
          Tasksteps: ['Submit Expense Report', 'Validate Required Fields'],
        },
        {
          id: 'wf5-s2', type: 'conditional', name: 'Amount Check',
          description: 'If amount > $1,000 → Manager Approval (Bob), else → Finance Auto-approve (Dave).',
          PreReq: ['wf5-s1'],
          condition: 'if/else', conditionExpr: 'amount > 1000',
          branches: ['if true → Manager Approval (Bob)', 'else → Finance Auto-approve (Dave)'],
          Tasksteps: ['Evaluate Claimed Amount'],
        },
        {
          id: 'wf5-s3', type: 'conditional', name: 'Route by Category',
          description: 'Switch on category: "travel" → Dave, otherwise → Alice.',
          PreReq: ['wf5-s2'],
          condition: 'switch', conditionExpr: 'category',
          branches: ['category === "travel" → Travel Desk (Dave)', 'otherwise → General Desk (Alice)'],
          Tasksteps: ['Classify Expense Category', 'Forward to Matching Desk'],
        },
        {
          id: 'wf5-s4', type: 'loop', name: 'Verify Receipts',
          description: 'For each receipt in the PG set, match it and mark it verified.',
          PreReq: ['wf5-s3'],
          loopSet: 'PG', loopExpr: 'for each receipt until all verified',
          Tasksteps: ['Open Next Receipt', 'Match to Line Item', 'Mark Verified'],
        },
        {
          id: 'wf5-s5', type: 'task', name: 'Reimburse & Close',
          description: 'Finance issues reimbursement and closes the report.',
          PreReq: ['wf5-s4'],
          Tasksteps: ['Issue Reimbursement', 'Notify Employee'],
        },
      ],
    },
  ];

  save(KEYS.users, users);
  save(KEYS.workflows, workflows);
  save(KEYS.instances, []);
  localStorage.setItem(KEYS.seeded, '1');
}

// ── Users ──────────────────────────────────────────────
export function getUsers() {
  seedIfNeeded();
  return load(KEYS.users);
}

// ── Workflows ──────────────────────────────────────────
export function getWorkflows() {
  seedIfNeeded();
  return load(KEYS.workflows);
}

export function getWorkflowForTrigger(triggerId) {
  const trig = TRIGGERS.find(t => t.id === triggerId);
  if (!trig || !trig.workflowId) return null;
  return getWorkflows().find(w => w.id === trig.workflowId) || null;
}

export function saveWorkflow(wf) {
  const list = load(KEYS.workflows);
  if (wf.id) {
    const idx = list.findIndex(w => w.id === wf.id);
    if (idx >= 0) { list[idx] = wf; } else { list.push(wf); }
  } else {
    wf = { ...wf, id: uid(), createdAt: new Date().toISOString() };
    list.push(wf);
  }
  save(KEYS.workflows, list);

  // Keep the trigger → workflow mapping in sync (in-memory; predefined list).
  if (wf.triggerId) {
    const trig = TRIGGERS.find(t => t.id === wf.triggerId);
    if (trig) trig.workflowId = wf.id;
  }
  return list;
}

export function deleteWorkflow(id) {
  save(KEYS.workflows, load(KEYS.workflows).filter(w => w.id !== id));
  TRIGGERS.forEach(t => { if (t.workflowId === id) t.workflowId = null; });
}

// ── Instances (launched workflows) ────────────────────
export function getInstances() { return load(KEYS.instances); }

// ── Execution helpers ──────────────────────────────────

function activateStep(si) {
  // All sub-steps of a task start active together (parallel by default).
  si.actionInstances.forEach(a => {
    if (a.status === 'blocked') a.status = 'active';
  });
}

// The orchestrator auto-assigns people (no manual Dispatcher). Round-robin
// across the team so every active sub-step has an owner.
function autoAssign(users, counterRef) {
  if (!users.length) return null;
  const u = users[counterRef.n % users.length];
  counterRef.n += 1;
  return u.id;
}

export function launchWorkflow(workflowId) {
  const wf = load(KEYS.workflows).find(w => w.id === workflowId);
  if (!wf) return null;

  const users = load(KEYS.users);
  const counterRef = { n: 0 };
  const now = new Date();

  const steps = wf.steps || wf.tasks || []; // tolerate old data

  const instance = {
    id: uid(),
    workflowId,
    workflowName: wf.name,
    launchedAt: now.toISOString(),
    status: 'running',
    taskInstances: steps.map((s, sIdx) => {
      const labels = s.Tasksteps && s.Tasksteps.length ? s.Tasksteps : [s.name];
      const actionInstances = labels.map((label, aIdx) => ({
        id: uid(),
        actionName: label,
        // Backend auto-assigns the person for this sub-step.
        assignedTo: autoAssign(users, counterRef),
        status: sIdx === 0 ? 'active' : 'blocked',
        completedAt: null,
        notes: '',
        order: aIdx,
      }));

      const si = {
        id: uid(),
        stepId: s.id,
        taskName: s.name,
        type: s.type || 'task',
        condition: s.condition || 'none',
        conditionExpr: s.conditionExpr || '',
        branches: s.branches || [],
        loopSet: s.loopSet || null,
        loopExpr: s.loopExpr || '',
        PreReq: s.PreReq || 'none',
        Tasksteps: labels,
        status: sIdx === 0 ? 'active' : 'pending',
        actionInstances,
      };

      if (sIdx === 0) activateStep(si);
      return si;
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
    // unlock the next pending step
    const nextStep = inst.taskInstances.find(t => t.status === 'pending');
    if (nextStep) {
      nextStep.status = 'active';
      activateStep(nextStep);
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
        if (ai.assignedTo === userId && ai.status === 'completed') {
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
