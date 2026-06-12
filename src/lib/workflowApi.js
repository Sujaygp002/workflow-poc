export async function startBulkUploadRun({ workbook, pdfs = [], orderZip = null, sourceLabel }) {
  const form = new FormData();
  form.append('workbook', workbook);
  pdfs.forEach((pdf) => form.append('pdfs', pdf));
  if (orderZip) form.append('orderZip', orderZip);
  if (sourceLabel) form.append('sourceLabel', sourceLabel);

  const res = await fetch('/api/workflows/bulk-upload/start', {
    method: 'POST',
    body: form,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Bulk upload failed');
  return body;
}

export async function fetchWorkflowRuns() {
  const res = await fetch('/api/workflow-runs');
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Unable to load DB workflow runs');
  return body.runs || [];
}

export async function fetchWorkflowDefinitions() {
  const res = await fetch('/api/workflows');
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Unable to load DB workflows');
  return body.workflows || [];
}

export async function fetchPatients() {
  const res = await fetch('/api/patients');
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Unable to load patients');
  return body.patients || [];
}

export async function fetchPatientTree(patientId) {
  const res = await fetch(`/api/patients/${encodeURIComponent(patientId)}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Unable to load patient');
  return body;
}

export async function fetchWorkItems(userId) {
  const res = await fetch(`/api/work-items${userId ? `?userId=${encodeURIComponent(userId)}` : ''}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Unable to load DB work items');
  return body;
}

export function dbWorkflowToWorkflow(row) {
  const definition = row.definition || {};
  return {
    ...definition,
    id: definition.id || row.id,
    name: definition.name || row.name,
    description: definition.description || row.description,
    createdAt: row.created_at,
    dbBacked: true,
    version: row.version,
    steps: (definition.steps || []).map((step) => ({
      ...step,
      type: step.actor === 'condition' ? 'conditional' : step.type || 'task',
      PreReq: Array.isArray(step.preReq) ? step.preReq : step.PreReq || 'none',
      conditionExpr: step.condition || step.conditionExpr || '',
    })),
  };
}

export async function completeDbWorkItem({ runId, taskRunId, notes = '', payload = {} }) {
  const res = await fetch(`/api/work-items/${taskRunId}/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ runId, notes, payload }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Unable to complete DB task');
  return body;
}

export function dbRunToInstance(run) {
  const definition = run.definition || {};
  const stepsById = Object.fromEntries((definition.steps || []).map((step) => [step.id, step]));
  const tasks = run.tasks || [];
  return {
    id: run.id,
    workflowId: run.workflow_id,
    workflowName: definition.name || run.workflow_id,
    launchedAt: run.created_at,
    status: run.status,
    dbBacked: true,
    taskInstances: tasks.map((task) => {
      const step = stepsById[task.step_id] || {};
      return {
        id: task.id,
        stepId: task.step_id,
        taskName: task.name,
        description: task.description || '',
        type: 'task',
        actor: task.actor,
        taskKind: task.task_key,
        condition: task.condition ? 'condition' : 'none',
        conditionExpr: task.condition || '',
        branches: [],
        PreReq: step.preReq || 'none',
        status: task.status,
        assignedTo: task.assigned_to,
        patientIndex: task.item_index,
        patientRecord: task.patient_payload,
        orderRecord: task.order_payload,
        referencePayload: task.reference_payload,
        decisions: task.decisions,
        actionInstances: [{
          id: task.id,
          actionName: task.name,
          assignedTo: task.assigned_to,
          status: task.status,
          completedAt: task.completed_at,
          notes: task.notes || '',
          order: 0,
        }],
      };
    }),
  };
}

export function dbWorkItemToAction(item) {
  return {
    dbBacked: true,
    instanceId: item.run_id,
    workflowName: item.workflow_id || 'wf7',
    launchedAt: item.run_created_at || item.created_at,
    taskInstanceId: item.id,
    actionInstanceId: item.id,
    taskName: item.name,
    actionName: item.name,
    description: item.description || '',
    type: 'task',
    taskKind: item.task_key,
    actor: item.actor,
    status: item.status,
    completedAt: item.completed_at,
    dbPayload: {
      patient: item.patient_payload,
      order: item.order_payload,
      references: item.reference_payload,
      extraction: item.extraction_payload,
      decisions: item.decisions,
    },
  };
}
