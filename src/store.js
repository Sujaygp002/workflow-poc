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
  seeded: 'wf_seeded_v17',
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
          // false → left, true → right (each points to a real task below)
          branches: ['false → Scheduled Doctor', 'true → On-call Doctor'],
          Tasksteps: [],
        },
        {
          id: 'wf1-s3', type: 'task', name: 'Scheduled Doctor',
          description: 'Non-urgent: route to the scheduled doctor (Carol).',
          PreReq: ['wf1-s2'],
          Tasksteps: ['Find Next Available Slot', 'Notify Scheduled Doctor'],
        },
        {
          id: 'wf1-s4', type: 'task', name: 'On-call Doctor',
          description: 'Urgent: page the on-call doctor (Bob) immediately.',
          PreReq: ['wf1-s2'],
          Tasksteps: ['Page On-call Doctor', 'Confirm Availability'],
        },
        {
          id: 'wf1-s5', type: 'task', name: 'Doctor Call-back',
          description: 'The assigned doctor calls the patient back.',
          PreReq: ['wf1-s3', 'wf1-s4'],
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
          trueTarget: 'wf2-s3', falseTarget: 'wf2-s4',
          branches: ['true → Verify Coverage', 'false → Self-pay Setup'],
          Tasksteps: [],
        },
        {
          id: 'wf2-s3', type: 'task', name: 'Verify Coverage',
          description: 'Has insurance: Carol verifies the coverage details.',
          PreReq: ['wf2-s2'],
          Tasksteps: ['Check Plan Eligibility', 'Record Coverage'],
        },
        {
          id: 'wf2-s4', type: 'task', name: 'Self-pay Setup',
          description: 'No insurance: Alice sets up a self-pay account.',
          PreReq: ['wf2-s2'],
          Tasksteps: ['Create Self-pay Account', 'Share Payment Options'],
        },
        {
          id: 'wf2-s5', type: 'task', name: 'Create Patient Record',
          description: 'Create the chart and notify the care team.',
          PreReq: ['wf2-s3', 'wf2-s4'],
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
          branches: ['inpatient → Inpatient Desk (Bob)', 'outpatient → Outpatient Desk (Carol)', 'pharmacy → Pharmacy Desk (Alice)'],
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
          description: 'If amount > $1,000 → Manager Approval (Bob), else → Finance Auto-approve (Carol).',
          PreReq: ['wf5-s1'],
          condition: 'if/else', conditionExpr: 'amount > 1000',
          branches: ['if true → Manager Approval (Bob)', 'else → Finance Auto-approve (Carol)'],
          Tasksteps: ['Evaluate Claimed Amount'],
        },
        {
          id: 'wf5-s3', type: 'conditional', name: 'Route by Category',
          description: 'Switch on category: "travel" → Carol, otherwise → Alice.',
          PreReq: ['wf5-s2'],
          condition: 'switch', conditionExpr: 'category',
          branches: ['category === "travel" → Travel Desk (Carol)', 'otherwise → General Desk (Alice)'],
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
//
// Execution is prerequisite + branch aware:
//   - A step becomes 'active' once ALL its prerequisites are completed
//     (skipped prereqs are treated as satisfied so flow can continue).
//   - A conditional randomly picks ONE branch target (if/else or switch case).
//     The chosen target activates; the NOT-chosen targets are 'skipped', and
//     any step that depended only on a skipped step cascades to 'skipped'.

function activateStep(si) {
  si.actionInstances.forEach(a => {
    if (a.status === 'blocked') a.status = 'active';
  });
  si.status = 'active';
}

// Round-robin auto-assignment across the team.
function autoAssign(users, counterRef) {
  if (!users.length) return null;
  const u = users[counterRef.n % users.length];
  counterRef.n += 1;
  return u.id;
}

// The single branch target a conditional routes to (random pick at launch).
function pickBranchTarget(step) {
  if (step.condition === 'switch') {
    const targets = (step.cases || []).map(c => c.target).filter(Boolean);
    if (!targets.length) return null;
    return targets[Math.floor(Math.random() * targets.length)];
  }
  // if/else
  const opts = [step.trueTarget, step.falseTarget].filter(Boolean);
  if (!opts.length) return null;
  return opts[Math.floor(Math.random() * opts.length)];
}

// Mark a step (by stepId) and everything reachable only through it as skipped.
function cascadeSkip(steps, statusByStepId, stepId) {
  if (statusByStepId[stepId] === 'skipped') return;
  statusByStepId[stepId] = 'skipped';
  for (const s of steps) {
    if (!Array.isArray(s.PreReq) || !s.PreReq.includes(stepId)) continue;
    // skip this dependent only if every prereq is now skipped
    const allSkipped = s.PreReq.every(p => statusByStepId[p] === 'skipped');
    if (allSkipped) cascadeSkip(steps, statusByStepId, s.id);
  }
}

export function launchWorkflow(workflowId) {
  const wf = load(KEYS.workflows).find(w => w.id === workflowId);
  if (!wf) return null;

  const users = load(KEYS.users);
  const counterRef = { n: 0 };
  const now = new Date();
  const steps = wf.steps || wf.tasks || [];

  // 1) Decide branch outcomes + which steps are skipped (by stepId).
  const statusByStepId = {}; // stepId -> 'skipped' (only skips recorded here)
  const chosenByCond = {};   // conditional stepId -> chosen target stepId
  for (const s of steps) {
    if (s.type !== 'conditional') continue;
    const allTargets = s.condition === 'switch'
      ? (s.cases || []).map(c => c.target).filter(Boolean)
      : [s.trueTarget, s.falseTarget].filter(Boolean);
    if (!allTargets.length) continue;
    const chosen = pickBranchTarget(s);
    chosenByCond[s.id] = chosen;
    allTargets.filter(t => t !== chosen).forEach(t => cascadeSkip(steps, statusByStepId, t));
  }

  // 2) Build task instances. A task is one atomic unit: exactly one assignee
  //    and one completion (no sub-steps / actions).
  const taskInstances = steps.map(s => {
    const skipped = statusByStepId[s.id] === 'skipped';
    const noPrereq = !Array.isArray(s.PreReq) || s.PreReq.length === 0;
    const startStatus = skipped ? 'skipped' : (noPrereq ? 'active' : 'pending');

    // Single action that represents the whole task (kept for the runtime
    // complete/unlock plumbing; never surfaced as a separate sub-step).
    const actionInstances = [{
      id: uid(),
      actionName: s.name,
      assignedTo: skipped ? null : autoAssign(users, counterRef),
      status: skipped ? 'skipped' : (noPrereq ? 'active' : 'blocked'),
      completedAt: null,
      notes: '',
      order: 0,
    }];

    return {
      id: uid(),
      stepId: s.id,
      taskName: s.name,
      description: s.description || '',
      type: s.type || 'task',
      condition: s.condition || 'none',
      conditionExpr: s.conditionExpr || '',
      branches: s.branches || [],
      trueTarget: s.trueTarget || null,
      falseTarget: s.falseTarget || null,
      cases: s.cases || [],
      chosenTarget: chosenByCond[s.id] || null,
      loopSet: s.loopSet || null,
      loopExpr: s.loopExpr || '',
      PreReq: s.PreReq || 'none',
      assignedTo: actionInstances[0].assignedTo,
      status: startStatus,
      actionInstances,
    };
  });

  const instance = {
    id: uid(),
    workflowId,
    workflowName: wf.name,
    launchedAt: now.toISOString(),
    status: 'running',
    taskInstances,
  };

  recomputeInstance(instance);

  const list = load(KEYS.instances);
  list.push(instance);
  save(KEYS.instances, list);
  return instance;
}

// Unlock any pending step whose prerequisites are all completed/skipped, and
// roll up the overall instance status.
function recomputeInstance(inst) {
  const doneStepIds = new Set(
    inst.taskInstances.filter(t => t.status === 'completed' || t.status === 'skipped').map(t => t.stepId)
  );

  for (const ti of inst.taskInstances) {
    if (ti.status !== 'pending') continue;
    const prereqs = Array.isArray(ti.PreReq) ? ti.PreReq : [];
    const ready = prereqs.every(p => doneStepIds.has(p));
    if (ready) activateStep(ti);
  }

  const live = inst.taskInstances.filter(t => t.status !== 'skipped');
  if (live.every(t => t.status === 'completed')) inst.status = 'completed';
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

  if (ti.actionInstances.filter(a => a.status !== 'skipped').every(a => a.status === 'completed')) {
    ti.status = 'completed';
  }

  recomputeInstance(inst);
  save(KEYS.instances, list);
  return list;
}

// ── Instance status header: unassigned → assigned → done ──
export function instanceStage(inst) {
  const live = inst.taskInstances.filter(t => t.status !== 'skipped');
  const allDone = live.every(t => t.status === 'completed');
  if (allDone) return 'done';
  const anyAssigned = live.some(t =>
    t.actionInstances.some(a => a.assignedTo && a.status !== 'skipped' && a.status !== 'completed')
  );
  return anyAssigned ? 'assigned' : 'unassigned';
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
            description: ti.description || '',
            type: ti.type || 'task',
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
