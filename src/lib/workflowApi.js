import { authHeaders } from './authApi.js';

export async function startBulkUploadRun({
  workbook,
  pdfs = [],
  unsignedZip = null,
  signedZip = null,
  // Back-compat alias: orderZip == unsigned order PDFs.
  orderZip = null,
  sourceLabel,
  areaId,
  hhahId,
  areaName,
  areaType,
  hhahName,
}) {
  const form = new FormData();
  form.append('workbook', workbook);
  pdfs.forEach((pdf) => form.append('pdfs', pdf));
  const unsigned = unsignedZip || orderZip;
  if (unsigned) form.append('unsignedZip', unsigned);
  if (signedZip) form.append('signedZip', signedZip);
  if (sourceLabel) form.append('sourceLabel', sourceLabel);
  if (areaId) form.append('areaId', areaId);
  if (hhahId) form.append('hhahId', hhahId);
  if (areaName) form.append('areaName', areaName);
  if (areaType) form.append('areaType', areaType);
  if (hhahName) form.append('hhahName', hhahName);

  const res = await fetch('/api/workflows/bulk-upload/start', {
    method: 'POST',
    headers: authHeaders('hhah'),
    body: form,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Bulk upload failed');
  return body;
}

export async function fetchAreaIntakeStatus() {
  const res = await fetch('/api/area-intake');
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Unable to load area intake status');
  return body.areas || [];
}

export async function runAreaIntakeCheck({ areaId, checkDate = null, now = null, forceExpired = false }) {
  const res = await fetch('/api/area-intake', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ areaId, checkDate, now, forceExpired }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Unable to run area intake check');
  return body;
}

export async function fetchWorkflowRuns() {
  const res = await fetch('/api/workflow-runs');
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Unable to load DB workflow runs');
  return body.runs || [];
}

export async function deleteWorkflowRun(runId) {
  const res = await fetch(`/api/workflow-runs/${encodeURIComponent(runId)}`, {
    method: 'DELETE',
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Unable to delete workflow run');
  return body;
}

export async function fetchWorkflowDefinitions() {
  const res = await fetch('/api/workflows');
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Unable to load DB workflows');
  return body.workflows || [];
}

export async function fetchPatients({ hhahId = '' } = {}) {
  const qs = hhahId ? `?hhahId=${encodeURIComponent(hhahId)}` : '';
  const res = await fetch(`/api/patients${qs}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Unable to load patients');
  return body.patients || [];
}

export async function fetchPatientUnits() {
  const res = await fetch('/api/patients?view=units');
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Unable to load patient units');
  return body.units || [];
}

export async function fetchOrders({ hhahId = '' } = {}) {
  const qs = hhahId ? `?hhahId=${encodeURIComponent(hhahId)}` : '';
  const res = await fetch(`/api/orders${qs}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Unable to load orders');
  return body.orders || [];
}

export async function fetchPgUnsignedOrders(pgId = '') {
  const qs = `?pgUnsigned=1${pgId ? `&pgId=${encodeURIComponent(pgId)}` : ''}`;
  const res = await fetch(`/api/orders${qs}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Unable to load PG unsigned orders');
  return body.orders || [];
}

export async function bulkSignPgOrders({ orderIds, pgId = '', date = '' }) {
  const res = await fetch('/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders('pg') },
    body: JSON.stringify({ action: 'bulkSign', orderIds, pgId, date }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Unable to bulk sign orders');
  return body;
}

export async function fetchPatientTree(patientId) {
  const res = await fetch(`/api/patients/${encodeURIComponent(patientId)}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Unable to load patient');
  return body;
}

export async function fetchReferenceData() {
  const res = await fetch('/api/reference-data');
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Unable to load reference data');
  return body;
}

async function postReferenceData(action, payload, failMessage) {
  const res = await fetch('/api/reference-data', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...payload }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || failMessage);
  return body;
}

export async function createAgency({ name, npi = '', contact = {} }) {
  return postReferenceData('createAgency', { name, npi, contact }, 'Unable to create agency');
}

export async function createPg({ name, npi = '' }) {
  return postReferenceData('createPg', { name, npi }, 'Unable to create PG');
}

export async function createPractitioner({ name, npi }) {
  return postReferenceData('createPractitioner', { name, npi }, 'Unable to create practitioner');
}

export async function mapPgToPractitioner({ pgId, practitionerId }) {
  return postReferenceData('mapPgPractitioner', { pgId, practitionerId }, 'Unable to map PG to practitioner');
}

// ── Builder workflows ────────────────────────────────────────────────────────
export async function saveWorkflow({ id, name, description = '', trigger, graph }) {
  const res = await fetch('/api/workflows', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'saveWorkflow', id, name, description, trigger, graph }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(body.error || 'Unable to save workflow');
    error.status = res.status;
    error.messages = body.messages || [];
    throw error;
  }
  return body;
}

export async function deleteWorkflow(id) {
  const res = await fetch('/api/workflows', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'deleteWorkflow', id }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Unable to delete workflow');
  return body;
}

export async function fetchBuilderCatalog() {
  const res = await fetch('/api/workflows', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'catalog' }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Unable to load builder catalog');
  return body;
}

export async function startWorkflow({ workflowId, items = undefined, sourceLabel = undefined }) {
  const res = await fetch('/api/workflow-runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'startWorkflow', workflowId, items, sourceLabel }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Unable to start workflow');
  return body;
}

export async function tickTimeTriggers() {
  const res = await fetch('/api/workflow-runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'tick' }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Unable to tick time triggers');
  return body;
}

// ── Simulated business time (Milestone D) ───────────────────────────────────
// Read the current simulated-business-clock state (offset + business date).
export async function fetchBusinessTime() {
  const res = await fetch('/api/workflow-runs?action=simTime');
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Unable to load business time');
  return body;
}

// Advance / reset the simulated business clock. op: '+1d' | '+1m' | 'reset'.
export async function simulateBusinessTime(op) {
  const res = await fetch('/api/workflow-runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'simulateTime', op }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Unable to simulate business time');
  return body;
}

// ── Worker buckets (bearer-scoped) ──────────────────────────────────────────
export async function fetchMyBuckets() {
  const res = await fetch('/api/work-items', { headers: authHeaders('worker') });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(body.error || 'Unable to load work buckets');
    error.status = res.status;
    throw error;
  }
  return body;
}

export async function openWorkItem(taskRunId) {
  const res = await fetch('/api/work-items', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders('worker') },
    body: JSON.stringify({ action: 'open', taskRunId }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(body.error || 'Unable to open work item');
    error.status = res.status;
    throw error;
  }
  return body;
}

export async function fetchWorkItems(userId) {
  const res = await fetch(`/api/work-items${userId ? `?userId=${encodeURIComponent(userId)}` : ''}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Unable to load DB work items');
  return body;
}

export async function fetchWorkUsers() {
  const body = await fetchWorkItems();
  return body.users || [];
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
    headers: { 'Content-Type': 'application/json', ...authHeaders('worker') },
    body: JSON.stringify({ runId, notes, payload }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // 400 validation contract: the task stays active/Processing and the body
    // carries per-action errors for inline display.
    const error = new Error(body.error || 'Unable to complete DB task');
    error.status = res.status;
    error.actionErrors = body.actionErrors || {};
    throw error;
  }
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
    areaId: run.area_id,
    areaName: run.area_name,
    areaType: run.area_type,
    hhahId: run.hhah_id,
    hhahName: run.hhah_name,
    inputSummary: run.input_summary || {},
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
    workflowName: item.workflow_id || '',
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
      missingFields: item.output?.missingFields || [],
      pdf: {
        fileName: item.pdf_file_name || item.extraction_payload?.pdf?.fileName,
        url: item.pdf_blob_url || item.extraction_payload?.pdf?.blobUrl,
        signed: item.extraction_payload?.pdf?.signed === true,
      },
    },
  };
}

export async function fetchRcmPatients({ hhahId, pgId, page = 1, limit = 10 } = {}) {
  const params = new URLSearchParams({ view: 'rcm', page, limit });
  if (hhahId) params.set('hhahId', hhahId);
  if (pgId) params.set('pgId', pgId);
  const res = await fetch(`/api/patients?${params}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function fetchRcmBilling({ hhahId, pgId, page = 1, limit = 10 } = {}) {
  const params = new URLSearchParams({ view: 'rcm-billing', page, limit });
  if (hhahId) params.set('hhahId', hhahId);
  if (pgId) params.set('pgId', pgId);
  const res = await fetch(`/api/patients?${params}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
