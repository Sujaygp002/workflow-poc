import { handleError, methodNotAllowed, readJson, sendJson } from '../_lib/http.js';
import { SEEDED_USERS, WF_BILLING_MONITOR_DEFINITION } from '../_lib/workflowDefinition.js';
import {
  createTaskRunsForItem,
  createWorkflowItem,
  createWorkflowRun,
  findWorkflowItemByIssueSignature,
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

function runnableStep(workflow, stepId) {
  const step = stepById(workflow.definition, stepId);
  if (!step) throw new Error(`Billing monitor step ${stepId} not found`);
  return { ...step, preReq: [], condition: null };
}

function hhahGroupKey(hhah = {}) {
  return hhah.id || hhah.name || 'unknown-hhah';
}

function groupIssue(groups, issue) {
  const key = hhahGroupKey(issue.hhah);
  if (!groups.has(key)) {
    groups.set(key, {
      hhah: issue.hhah || {},
      issues: [],
    });
  }
  groups.get(key).issues.push(issue);
}

async function findExistingBillingIssue(workflow, issueSignature, legacySourceLabel) {
  const existingItem = await findWorkflowItemByIssueSignature(workflow.id, issueSignature);
  if (existingItem) return { run_id: existingItem.run_id };
  const existingRun = legacySourceLabel
    ? await findWorkflowRunBySourceLabel(workflow.id, legacySourceLabel)
    : null;
  return existingRun ? { run_id: existingRun.id } : null;
}

async function createHhahIssueRun({ workflow, group }) {
  const sourceKey = String(hhahGroupKey(group.hhah)).replace(/[^a-zA-Z0-9_-]/g, '-');
  const run = await createWorkflowRun({
    workflowId: workflow.id,
    workflowVersion: workflow.version,
    sourceLabel: `billing-monitor:hhah:${sourceKey}:${new Date().toISOString()}`,
    totalItems: group.issues.length,
    inputSummary: {
      trigger: 'billing-monitor',
      groupedBy: 'hhah',
      hhahId: group.hhah?.id || null,
      hhahName: group.hhah?.name || 'Unknown HHAH',
      issueCount: group.issues.length,
      issueTypes: [...new Set(group.issues.map((issue) => issue.issueType))],
    },
    hhahId: group.hhah?.id || null,
  });

  const stepsById = new Map();
  const itemIds = [];
  for (let itemIndex = 0; itemIndex < group.issues.length; itemIndex += 1) {
    const issue = group.issues[itemIndex];
    const step = runnableStep(workflow, issue.stepId);
    stepsById.set(step.id, step);
    const item = await createWorkflowItem({
      runId: run.id,
      itemIndex,
      patientPayload: issue.patientPayload || {},
      orderPayload: issue.orderPayload || {},
      referencePayload: issue.referencePayload || {},
      extractionPayload: issue.extractionPayload || {},
    });
    itemIds.push(item.id);
    await createTaskRunsForItem({ runId: run.id, itemId: item.id, steps: [step] });
  }

  await runWorkflowAutomation({
    runId: run.id,
    definition: { ...workflow.definition, steps: [...stepsById.values()] },
    concurrency: Math.max(1, group.issues.length),
  });
  return { created: true, runId: run.id, itemIds, hhahId: group.hhah?.id || null, hhahName: group.hhah?.name || null };
}

async function runBillingMonitorHandler() {
  const workflow = await ensureBillingWorkflow();
  const result = await runBillingMonitorPass();
  const tasks = [];
  const groups = new Map();

  for (const issue of result.issues.missingDocuments) {
    const issueSignature = `missing-docs:${issue.episode.id}`;
    const existing = await findExistingBillingIssue(workflow, issueSignature, `billing-monitor:missing-docs:${issue.episode.id}`);
    if (existing) {
      tasks.push({ created: false, existingRunId: existing.run_id, issueSignature });
      continue;
    }
    groupIssue(groups, {
      issueType: 'missing-docs',
      issueSignature,
      hhah: issue.hhah || {},
      stepId: 'billing-s2',
      referencePayload: {
        HHAH: issue.hhah || {},
      },
      extractionPayload: {
        issueType: 'missing-docs',
        issueSignature,
        episodeId: issue.episode.id,
        admissionId: issue.episode.admission_id,
        eligible: false,
        missingDocuments: issue.missingDocuments,
        reason: issue.reason,
      },
      patientPayload: {},
      orderPayload: {},
    });
  }

  for (const issue of result.issues.physicianReminders) {
    const issueSignature = `signature:${issue.episode.id}`;
    const existing = await findExistingBillingIssue(workflow, issueSignature, `billing-monitor:signature:${issue.episode.id}`);
    if (existing) {
      tasks.push({ created: false, existingRunId: existing.run_id, issueSignature });
      continue;
    }
    const firstOrder = issue.orders[0] || {};
    groupIssue(groups, {
      issueType: 'signature',
      issueSignature,
      hhah: issue.hhah || {},
      stepId: 'billing-s5',
      referencePayload: {
        HHAH: issue.hhah || {},
      },
      orderPayload: {
        order_info: {
          order_number: firstOrder.order_number || '',
          order_type: firstOrder.order_type || firstOrder.document_type || '',
          order_date: firstOrder.order_date || '',
        },
        order_status: firstOrder.order_status || {},
      },
      extractionPayload: {
        issueType: 'signature',
        issueSignature,
        episodeId: issue.episode.id,
        admissionId: issue.episode.admission_id,
        eligible: true,
        billable: false,
        unsignedOrderNumbers: issue.unsignedOrderNumbers,
      },
    });
  }

  for (const issue of result.issues.cpoMinutes) {
    const issueSignature = `cpo:${issue.cpoMonth.id}`;
    const existing = await findExistingBillingIssue(workflow, issueSignature, `billing-monitor:cpo:${issue.cpoMonth.id}`);
    if (existing) {
      tasks.push({ created: false, existingRunId: existing.run_id, issueSignature });
      continue;
    }
    groupIssue(groups, {
      issueType: 'cpo',
      issueSignature,
      hhah: issue.hhah || {},
      stepId: 'billing-s7',
      referencePayload: {
        HHAH: issue.hhah || {},
      },
      extractionPayload: {
        issueType: 'cpo',
        issueSignature,
        episodeId: issue.episode.id,
        cpoMonthId: issue.cpoMonth.id,
        cpoMonth: issue.cpoMonth.cpo_month,
        cpoMin: issue.cpoMonth.cpo_min,
        eligible: true,
        billable: true,
        cpoMonthBillable: false,
      },
    });
  }

  for (const group of groups.values()) {
    tasks.push(await createHhahIssueRun({ workflow, group }));
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
