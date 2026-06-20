import { handleError, methodNotAllowed, readJson, sendJson } from '../_lib/http.js';
import { SEEDED_USERS, WF_BILLING_MONITOR_DEFINITION } from '../_lib/workflowDefinition.js';
import {
  createTaskRunsForItem,
  createWorkflowItem,
  createWorkflowRun,
  findWorkflowRunBySourceLabel,
  getActiveWorkflow,
  listTaskRunsForRun,
  listWorkflowRuns,
  runBillingMonitorPass,
  upsertUser,
  upsertWorkflowDefinition,
} from '../_lib/repositories.js';
import { runWorkflowAutomation } from '../_lib/workflowEngine.js';

async function ensureBillingWorkflow() {
  let workflow = await getActiveWorkflow(WF_BILLING_MONITOR_DEFINITION.id);
  if (!workflow) {
    for (const user of SEEDED_USERS) await upsertUser(user);
    await upsertWorkflowDefinition(WF_BILLING_MONITOR_DEFINITION, 1);
    workflow = await getActiveWorkflow(WF_BILLING_MONITOR_DEFINITION.id);
  }
  return workflow;
}

function stepById(definition, stepId) {
  return (definition.steps || []).find((step) => step.id === stepId);
}

async function createIssueTask({ workflow, sourceLabel, stepId, itemIndex, patientPayload = {}, orderPayload = {}, referencePayload = {}, extractionPayload = {} }) {
  const existing = await findWorkflowRunBySourceLabel(workflow.id, sourceLabel);
  if (existing) return { created: false, existingRunId: existing.id };

  const step = stepById(workflow.definition, stepId);
  if (!step) throw new Error(`Billing monitor step ${stepId} not found`);
  const runnableStep = { ...step, preReq: [], condition: null };

  const run = await createWorkflowRun({
    workflowId: workflow.id,
    workflowVersion: workflow.version,
    sourceLabel,
    totalItems: 1,
    inputSummary: { trigger: 'billing-monitor', stepId },
  });
  const item = await createWorkflowItem({
    runId: run.id,
    itemIndex,
    patientPayload,
    orderPayload,
    referencePayload,
    extractionPayload,
  });
  await createTaskRunsForItem({ runId: run.id, itemId: item.id, steps: [runnableStep] });
  await runWorkflowAutomation({ runId: run.id, definition: { ...workflow.definition, steps: [runnableStep] }, concurrency: 1 });
  return { created: true, runId: run.id, itemId: item.id };
}

async function runBillingMonitorHandler() {
  const workflow = await ensureBillingWorkflow();
  const result = await runBillingMonitorPass();
  let itemIndex = 0;
  const tasks = [];

  for (const issue of result.issues.missingDocuments) {
    tasks.push(await createIssueTask({
      workflow,
      sourceLabel: `billing-monitor:missing-docs:${issue.episode.id}`,
      stepId: 'billing-s2',
      itemIndex,
      referencePayload: {
        HHAH: issue.hhah || {},
      },
      extractionPayload: {
        episodeId: issue.episode.id,
        admissionId: issue.episode.admission_id,
        eligible: false,
        missingDocuments: issue.missingDocuments,
        reason: issue.reason,
      },
      patientPayload: {},
      orderPayload: {},
    }));
    itemIndex += 1;
  }

  for (const issue of result.issues.physicianReminders) {
    const firstOrder = issue.orders[0] || {};
    tasks.push(await createIssueTask({
      workflow,
      sourceLabel: `billing-monitor:signature:${issue.episode.id}`,
      stepId: 'billing-s5',
      itemIndex,
      orderPayload: {
        order_info: {
          order_number: firstOrder.order_number || '',
          order_type: firstOrder.order_type || firstOrder.document_type || '',
          order_date: firstOrder.order_date || '',
        },
        order_status: firstOrder.order_status || {},
      },
      extractionPayload: {
        episodeId: issue.episode.id,
        admissionId: issue.episode.admission_id,
        eligible: true,
        billable: false,
        unsignedOrderNumbers: issue.unsignedOrderNumbers,
      },
    }));
    itemIndex += 1;
  }

  for (const issue of result.issues.cpoMinutes) {
    tasks.push(await createIssueTask({
      workflow,
      sourceLabel: `billing-monitor:cpo:${issue.cpoMonth.id}`,
      stepId: 'billing-s7',
      itemIndex,
      extractionPayload: {
        episodeId: issue.episode.id,
        cpoMonthId: issue.cpoMonth.id,
        cpoMonth: issue.cpoMonth.cpo_month,
        cpoMin: issue.cpoMonth.cpo_min,
        eligible: true,
        billable: true,
        cpoMonthBillable: false,
      },
    }));
    itemIndex += 1;
  }

  return {
    updatedEpisodes: result.updatedEpisodes.length,
    updatedPatients: result.updatedPatients.length,
      updatedCpoMonths: result.updatedCpoMonths.length,
      issues: {
        missingDocuments: result.issues.missingDocuments.length,
        physicianReminders: result.issues.physicianReminders.length,
        cpoMinutes: result.issues.cpoMinutes.length,
    },
    tasks,
  };
}

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const runs = await listWorkflowRuns();
      const withTasks = [];
      for (const run of runs) {
        const tasks = await listTaskRunsForRun(run.id);
        withTasks.push({ ...run, tasks });
      }
      return sendJson(res, 200, { runs: withTasks });
    }

    if (req.method === 'POST') {
      const body = await readJson(req);
      if (body.action !== 'runBillingMonitor') {
        return sendJson(res, 400, { error: 'Unsupported workflow-runs action.' });
      }
      return sendJson(res, 200, await runBillingMonitorHandler());
    }

    return methodNotAllowed(res, ['GET', 'POST']);
  } catch (error) {
    return handleError(res, error);
  }
}
