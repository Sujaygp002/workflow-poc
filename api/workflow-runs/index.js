import { handleError, methodNotAllowed, readJson, sendJson } from '../_lib/http.js';
import { WF_BILLING_MONITOR_DEFINITION } from '../_lib/workflowDefinition.js';
import {
  countWorkflowItems,
  createTaskRunsForItem,
  createWorkflowItem,
  createWorkflowRun,
  ensureSystemDefinitions,
  findActiveWorkflowRunForHhah,
  findNewestRunForWorkflow,
  findWorkflowItemByIssueSignature,
  findWorkflowRunBySourceLabel,
  getActiveWorkflow,
  getRunWithDefinition,
  listActiveAgencies,
  listActiveBuilderWorkflowsByTrigger,
  listTaskRunsForRun,
  listTaskRunsForRuns,
  listWorkflowRuns,
  runBillingMonitorPass,
} from '../_lib/repositories.js';
import { runWorkflowAutomation } from '../_lib/workflowEngine.js';
import { dailySourceLabel, nowPartsInTz } from '../_lib/dailyBucket.js';
import { httpError } from '../_lib/auth.js';

async function ensureBillingWorkflow() {
  await ensureSystemDefinitions();
  return getActiveWorkflow(WF_BILLING_MONITOR_DEFINITION.id);
}

// Manual trigger: start a run of any active workflow (builder Run button).
// Default items = one empty item so system steps/conditions can still evaluate.
async function startWorkflowHandler(body) {
  const workflow = await getActiveWorkflow(body.workflowId);
  if (!workflow) throw httpError(404, 'Workflow not found');
  const items = Array.isArray(body.items) && body.items.length ? body.items : [{}];
  const run = await createWorkflowRun({
    workflowId: workflow.id,
    workflowVersion: workflow.version,
    sourceLabel: body.sourceLabel || `manual:${workflow.id}:${Date.now()}`,
    totalItems: items.length,
    inputSummary: { trigger: 'manual', workflowName: workflow.name, itemCount: items.length },
  });
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i] || {};
    const created = await createWorkflowItem({
      runId: run.id,
      itemIndex: i,
      patientPayload: item.patientPayload || {},
      orderPayload: item.orderPayload || {},
      referencePayload: item.referencePayload || {},
      extractionPayload: item.extractionPayload || {},
    });
    await createTaskRunsForItem({ runId: run.id, itemId: created.id, steps: workflow.definition.steps });
  }
  await runWorkflowAutomation({ runId: run.id, definition: workflow.definition });
  const refreshed = await getRunWithDefinition(run.id);
  const tasks = await listTaskRunsForRun(run.id);
  return { run: refreshed, tasks };
}

// Time trigger: for each active builder workflow with trigger.type =
// 'time_interval', start a run when the newest run is older than the interval.
// Idempotent via bucketed source labels (builder-tick:<wfId>:<bucketTs>).
async function tickHandler() {
  const workflows = await listActiveBuilderWorkflowsByTrigger('time_interval');
  const started = [];
  for (const workflow of workflows) {
    const intervalSeconds = Math.max(5, Number(workflow.definition?.trigger?.intervalSeconds) || 60);
    const newest = await findNewestRunForWorkflow(workflow.id);
    if (newest && Date.now() - new Date(newest.created_at).getTime() < intervalSeconds * 1000) continue;
    const bucketTs = Math.floor(Date.now() / 1000 / intervalSeconds) * intervalSeconds;
    const sourceLabel = `builder-tick:${workflow.id}:${bucketTs}`;
    const existing = await findWorkflowRunBySourceLabel(workflow.id, sourceLabel);
    if (existing) continue;
    const run = await createWorkflowRun({
      workflowId: workflow.id,
      workflowVersion: workflow.version,
      sourceLabel,
      totalItems: 1,
      inputSummary: { trigger: 'time_interval', intervalSeconds, workflowName: workflow.name },
    });
    const item = await createWorkflowItem({
      runId: run.id,
      itemIndex: 0,
      patientPayload: {},
      orderPayload: {},
      referencePayload: {},
      extractionPayload: {},
    });
    await createTaskRunsForItem({ runId: run.id, itemId: item.id, steps: workflow.definition.steps });
    await runWorkflowAutomation({ runId: run.id, definition: workflow.definition });
    started.push(run.id);
  }
  const daily = await dailyTimeTickHandler();
  return { started, daily: daily.started, dailySkipped: daily.skipped };
}

// daily_time trigger: fire ONCE per day (per active builder workflow) when the
// current time in the trigger tz has reached hour:minute AND no run exists for
// today's bucket. Each firing creates one run with one item per active agency;
// referencePayload.HHAH = {id,name,contact}, extraction_payload.dayBucket set.
// Idempotent via sourceLabel daily:<wfId>:<dayBucket>.
async function dailyTimeTickHandler() {
  const workflows = await listActiveBuilderWorkflowsByTrigger('daily_time');
  const started = [];
  const skipped = [];
  for (const workflow of workflows) {
    const trigger = workflow.definition?.trigger || {};
    const tz = trigger.tz || 'America/Chicago';
    const targetHour = Number.isFinite(Number(trigger.hour)) ? Number(trigger.hour) : 12;
    const targetMinute = Number.isFinite(Number(trigger.minute)) ? Number(trigger.minute) : 0;
    const { dayBucket, hour, minute } = nowPartsInTz(tz);

    // Not yet time today.
    if (hour * 60 + minute < targetHour * 60 + targetMinute) {
      skipped.push({ workflowId: workflow.id, reason: 'before_fire_time', dayBucket });
      continue;
    }

    const sourceLabel = dailySourceLabel(workflow.id, dayBucket);
    const existing = await findWorkflowRunBySourceLabel(workflow.id, sourceLabel);
    if (existing) {
      skipped.push({ workflowId: workflow.id, reason: 'already_ran_today', dayBucket });
      continue;
    }

    const agencies = await listActiveAgencies();
    const run = await createWorkflowRun({
      workflowId: workflow.id,
      workflowVersion: workflow.version,
      sourceLabel,
      totalItems: Math.max(1, agencies.length),
      inputSummary: { trigger: 'daily_time', dayBucket, tz, workflowName: workflow.name, agencyCount: agencies.length },
    });

    for (let i = 0; i < agencies.length; i += 1) {
      const agency = agencies[i];
      const contact = agency.contact_info || {};
      const item = await createWorkflowItem({
        runId: run.id,
        itemIndex: i,
        patientPayload: {},
        orderPayload: {},
        referencePayload: { HHAH: { id: agency.id, name: agency.name, contact } },
        extractionPayload: { dayBucket, tz },
      });
      await createTaskRunsForItem({ runId: run.id, itemId: item.id, steps: workflow.definition.steps });
    }

    await runWorkflowAutomation({ runId: run.id, definition: workflow.definition, concurrency: Math.max(1, agencies.length) });
    started.push({ runId: run.id, workflowId: workflow.id, dayBucket, agencyCount: agencies.length });
  }
  return { started, skipped };
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

// New (already-deduped) issues for an HHAH that still has an active run get APPENDED
// to that run as fresh items, rather than skipped — otherwise issues discovered after
// the run was created (e.g. CPO months that only became checkable once the episode
// turned billable) would silently wait until the whole run completes.
async function appendIssuesToRun({ workflow, runId, issues }) {
  const existingCount = await countWorkflowItems(runId);
  const stepsById = new Map();
  const itemIds = [];
  for (let offset = 0; offset < issues.length; offset += 1) {
    const issue = issues[offset];
    const step = runnableStep(workflow, issue.stepId);
    stepsById.set(step.id, step);
    const item = await createWorkflowItem({
      runId,
      itemIndex: existingCount + offset,
      patientPayload: issue.patientPayload || {},
      orderPayload: issue.orderPayload || {},
      referencePayload: issue.referencePayload || {},
      extractionPayload: issue.extractionPayload || {},
    });
    itemIds.push(item.id);
    await createTaskRunsForItem({ runId, itemId: item.id, steps: [step] });
  }
  await runWorkflowAutomation({
    runId,
    definition: { ...workflow.definition, steps: [...stepsById.values()] },
    concurrency: Math.max(1, issues.length),
  });
  return itemIds;
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
    const activeRun = await findActiveWorkflowRunForHhah(
      workflow.id,
      group.hhah?.id || null,
      group.hhah?.name || null,
    );
    if (activeRun) {
      // Append the new issues to the in-flight run for this HHAH instead of dropping them.
      const itemIds = await appendIssuesToRun({ workflow, runId: activeRun.id, issues: group.issues });
      tasks.push({
        created: false,
        appended: true,
        reason: 'appended_to_active_hhah_billing_run',
        existingRunId: activeRun.id,
        hhahId: group.hhah?.id || null,
        hhahName: group.hhah?.name || 'Unknown HHAH',
        issueCount: group.issues.length,
        itemIds,
      });
      continue;
    }
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

function actionFromUrl(req) {
  // req.query is populated by Vercel; the local shim may only set req.url.
  if (req.query && req.query.action) return req.query.action;
  try {
    const url = new URL(req.url, 'http://localhost');
    return url.searchParams.get('action');
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      // GET /api/workflow-runs?action=tick — lets a vercel.json cron fire the
      // daily_time (and time_interval) triggers with a simple GET.
      if (actionFromUrl(req) === 'tick') {
        return sendJson(res, 200, await tickHandler());
      }
      const runs = await listWorkflowRuns();
      const allTasks = await listTaskRunsForRuns(runs.map((run) => run.id));
      const tasksByRun = new Map();
      for (const task of allTasks) {
        const list = tasksByRun.get(task.run_id) || [];
        list.push(task);
        tasksByRun.set(task.run_id, list);
      }
      const withTasks = runs.map((run) => ({ ...run, tasks: tasksByRun.get(run.id) || [] }));
      return sendJson(res, 200, { runs: withTasks });
    }

    if (req.method === 'POST') {
      const body = await readJson(req);
      switch (body.action) {
        case 'runBillingMonitor':
          return sendJson(res, 200, await runBillingMonitorHandler());
        case 'startWorkflow':
          return sendJson(res, 201, await startWorkflowHandler(body));
        case 'tick':
          return sendJson(res, 200, await tickHandler());
        default:
          return sendJson(res, 400, { error: 'Unsupported workflow-runs action.' });
      }
    }

    return methodNotAllowed(res, ['GET', 'POST']);
  } catch (error) {
    return handleError(res, error);
  }
}
